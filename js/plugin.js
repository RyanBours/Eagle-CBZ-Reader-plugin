const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const unrar = require('node-unrar-js');
let heicConvert = null;

try {
	heicConvert = require('heic-convert');
} catch (error) {
	console.warn('heic-convert is not available. HEIC files will use native decode fallback.', error?.message || error);
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];
const SUPPORTED_MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

function normalizeZipPath(zipPath) {
	if (!zipPath) return '';
	return zipPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function getEntryExtension(file) {
	const normalizedPath = normalizeZipPath(file?.path || '');
	return path.extname(normalizedPath).toLowerCase();
}

function isDirectoryEntry(file) {
	const normalizedPath = normalizeZipPath(file?.path || '');
	return file?.type === 'Directory' || normalizedPath.endsWith('/');
}

function isSupportedMediaEntry(file) {
	if (!file || isDirectoryEntry(file)) {
		return false;
	}

	const normalizedPath = normalizeZipPath(file.path);
	const ext = getEntryExtension(file);
	return SUPPORTED_MEDIA_EXTENSIONS.includes(ext) && !normalizedPath.startsWith('__MACOSX/');
}

function sortByNormalizedPath(a, b) {
	const pathA = normalizeZipPath(a.path);
	const pathB = normalizeZipPath(b.path);
	return pathA.localeCompare(pathB, undefined, { numeric: true, sensitivity: 'base' });
}

function matchesSignature(header, signature) {
	if (!header || header.length < signature.length) {
		return false;
	}

	for (let index = 0; index < signature.length; index++) {
		if (header[index] !== signature[index]) {
			return false;
		}
	}

	return true;
}

function detectArchiveFormat(filePath) {
	let fileDescriptor;
	try {
		fileDescriptor = fs.openSync(filePath, 'r');
		const header = Buffer.alloc(8);
		const bytesRead = fs.readSync(fileDescriptor, header, 0, 8, 0);
		const signature = header.subarray(0, bytesRead);

		const zipLocal = [0x50, 0x4B, 0x03, 0x04];
		const zipEmpty = [0x50, 0x4B, 0x05, 0x06];
		const zipSpanned = [0x50, 0x4B, 0x07, 0x08];
		if (matchesSignature(signature, zipLocal) || matchesSignature(signature, zipEmpty) || matchesSignature(signature, zipSpanned)) {
			return 'zip';
		}

		const rar4 = [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00];
		const rar5 = [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00];
		if (matchesSignature(signature, rar4) || matchesSignature(signature, rar5)) {
			return 'rar';
		}

		const sevenZip = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
		if (matchesSignature(signature, sevenZip)) {
			return '7z';
		}

		return 'unknown';
	} catch (error) {
		console.warn('Failed to detect archive format.', error?.message || error);
		return 'unknown';
	} finally {
		if (typeof fileDescriptor === 'number') {
			try {
				fs.closeSync(fileDescriptor);
			} catch (_closeError) {
				// ignore close errors
			}
		}
	}
}

async function getArchiveEntries(filePath, archiveFormat) {
	if (archiveFormat === 'rar') {
		const archiveData = fs.readFileSync(filePath);
		const extractor = await unrar.createExtractorFromData({
			data: Uint8Array.from(archiveData).buffer
		});
		const extracted = extractor.extract();
		const extractedFiles = [...extracted.files];

		return extractedFiles.map((entry) => {
			const fileHeader = entry.fileHeader || {};
			const isDirectory = !!fileHeader.flags?.directory;
			return {
				path: fileHeader.name || '',
				type: isDirectory ? 'Directory' : 'File',
				buffer: async () => toNodeBuffer(entry.extraction)
			};
		});
	}

	const directory = await unzipper.Open.file(filePath);
	return directory.files;
}

// Comic reader state
let currentPage = 1;
let totalPages = 0;
let pages = [];
let currentZoom = 1;
let zoomIndicatorTimeout = null;
let autoFitOnPageChange = true;
let dualPageMode = false;
let coverOffset = false;
let leftToRight = false;

// Pan state
let isPanning = false;
let startX = 0;
let startY = 0;
let panX = 0;
let panY = 0;

// UI Elements
let comicImage, pageInput, totalPagesSpan, prevBtn, nextBtn, loader, comicViewer, zoomIndicator, recenterBtn, fitBtn, autoFitBtn;
let previewToggleBtn, previewPanel, thumbnailGrid, dualPageBtn, comicImage2, coverOffsetBtn, readDirectionBtn;
let comicVideo, comicVideo2;
let activeObjectUrls = new Set();

function isHeic(ext) {
	return ext === '.heic' || ext === '.heif';
}

function getVideoMimeType(ext) {
	switch (ext) {
		case 'mp4':
		case 'm4v':
			return 'video/mp4';
		case 'webm':
			return 'video/webm';
		case 'mov':
			return 'video/quicktime';
		case 'ogv':
			return 'video/ogg';
		default:
			return `video/${ext}`;
	}
}

function createVideoThumbPlaceholder(pageNumber) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240" viewBox="0 0 180 240"><rect width="100%" height="100%" fill="#222"/><polygon points="70,80 130,120 70,160" fill="#25b09b"/><text x="90" y="210" font-family="Arial, sans-serif" font-size="16" text-anchor="middle" fill="#fff">Video ${pageNumber}</text></svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function toNodeBuffer(value) {
	if (Buffer.isBuffer(value)) {
		return value;
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}
	return Buffer.from(value || []);
}

function createMediaSource(buffer, mimeType, useObjectUrl = false) {
	const normalizedBuffer = toNodeBuffer(buffer);

	if (useObjectUrl && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
		try {
			const blob = new Blob([normalizedBuffer], { type: mimeType });
			const objectUrl = URL.createObjectURL(blob);
			activeObjectUrls.add(objectUrl);
			return objectUrl;
		} catch (error) {
			console.warn('Failed to create object URL, falling back to data URL.', error?.message || error);
		}
	}

	const base64 = normalizedBuffer.toString('base64');
	return `data:${mimeType};base64,${base64}`;
}

function clearVideoElementSource(videoElement) {
	if (!videoElement) return;
	videoElement.pause();
	videoElement.removeAttribute('src');
	videoElement.load();
}

function revokeActiveObjectUrls() {
	if (!activeObjectUrls.size) return;
	for (const objectUrl of activeObjectUrls) {
		try {
			URL.revokeObjectURL(objectUrl);
		} catch (error) {
			console.warn('Failed to revoke object URL.', error?.message || error);
		}
	}
	activeObjectUrls = new Set();
}

async function createPageFromZipFile(file, pageNumber) {
	const ext = getEntryExtension(file);
	let buffer = toNodeBuffer(await file.buffer());
	let mimeType;

	if (IMAGE_EXTENSIONS.includes(ext)) {
		if (isHeic(ext)) {
			if (heicConvert) {
				try {
					buffer = toNodeBuffer(await heicConvert({
						buffer,
						format: 'JPEG',
						quality: 0.9
					}));
					mimeType = 'image/jpeg';
				} catch (convertError) {
					console.warn(`HEIC conversion failed for ${normalizeZipPath(file.path)}. Falling back to native decode.`, convertError?.message || convertError);
					mimeType = 'image/heic';
				}
			} else {
				mimeType = 'image/heic';
			}
		}

		if (!mimeType) {
			mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.substring(1)}`;
		}
		const src = createMediaSource(buffer, mimeType);

		return {
			type: 'image',
			src,
			thumbnailSrc: src
		};
	}

	if (VIDEO_EXTENSIONS.includes(ext)) {
		const mimeType = getVideoMimeType(ext.substring(1));
		return {
			type: 'video',
			src: createMediaSource(buffer, mimeType, true),
			thumbnailSrc: createVideoThumbPlaceholder(pageNumber)
		};
	}

	return null;
}

eagle.onPluginCreate((plugin) => {
	console.log('eagle.onPluginCreate');
	console.log(plugin);

	pluginInit();
});

function pluginInit() {
	// Initialize UI elements
	comicImage = document.getElementById('comic-image');
	pageInput = document.getElementById('page-input');
	totalPagesSpan = document.getElementById('total-pages');
	prevBtn = document.getElementById('prev-btn');
	nextBtn = document.getElementById('next-btn');
	loader = document.getElementById('loader');
	comicViewer = document.getElementById('comic-viewer');
	zoomIndicator = document.getElementById('zoom-indicator');
	recenterBtn = document.getElementById('recenter-btn');
	fitBtn = document.getElementById('fit-btn');
	autoFitBtn = document.getElementById('auto-fit-btn');
	previewToggleBtn = document.getElementById('preview-toggle-btn');
	previewPanel = document.getElementById('preview-panel');
	thumbnailGrid = document.getElementById('thumbnail-grid');
	dualPageBtn = document.getElementById('dual-page-btn');
	comicImage2 = document.getElementById('comic-image-2');
	comicVideo = document.getElementById('comic-video');
	comicVideo2 = document.getElementById('comic-video-2');
	coverOffsetBtn = document.getElementById('cover-offset-btn');
	readDirectionBtn = document.getElementById('read-direction-btn');

	console.log('UI Elements initialized:', {
		recenterBtn: !!recenterBtn,
		fitBtn: !!fitBtn,
		autoFitBtn: !!autoFitBtn,
		previewToggleBtn: !!previewToggleBtn,
		comicImage: !!comicImage,
		comicViewer: !!comicViewer
	});

	// Add event listeners
	prevBtn.addEventListener('click', previousPage);
	nextBtn.addEventListener('click', nextPage);
	pageInput.addEventListener('change', goToPage);
	pageInput.addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			goToPage();
		}
	});

	// Add zoom listener
	comicViewer.addEventListener('wheel', handleZoom, { passive: false });

	// Add zoom control listeners
	recenterBtn.addEventListener('click', recenterImage);
	fitBtn.addEventListener('click', fitToScreen);
	autoFitBtn.addEventListener('click', toggleAutoFit);
	previewToggleBtn.addEventListener('click', togglePreview);
	dualPageBtn.addEventListener('click', toggleDualPage);
	coverOffsetBtn.addEventListener('click', toggleCoverOffset);
	readDirectionBtn.addEventListener('click', toggleReadDirection);

	// Add pan listeners
	comicViewer.addEventListener('mousedown', startPan);
	comicViewer.addEventListener('mousemove', doPan);
	comicViewer.addEventListener('mouseup', endPan);
	comicViewer.addEventListener('mouseleave', endPan);
}

function getPrimaryMediaElement() {
	if (comicVideo && !comicVideo.classList.contains('hidden')) {
		return comicVideo;
	}
	if (comicImage && !comicImage.classList.contains('hidden')) {
		return comicImage;
	}
	return null;
}

function getSecondaryMediaElement() {
	if (comicVideo2 && !comicVideo2.classList.contains('hidden')) {
		return comicVideo2;
	}
	if (comicImage2 && !comicImage2.classList.contains('hidden')) {
		return comicImage2;
	}
	return null;
}

function getMediaDimensions(element) {
	if (!element) {
		return { width: 0, height: 0 };
	}

	if (element.tagName === 'VIDEO') {
		return {
			width: element.videoWidth || 0,
			height: element.videoHeight || 0
		};
	}

	return {
		width: element.width || 0,
		height: element.height || 0
	};
}

function handleZoom(event) {
	const primaryMedia = getPrimaryMediaElement();
	const { width } = getMediaDimensions(primaryMedia);
	if (!primaryMedia || !width) return;

	event.preventDefault();

	const zoomSpeed = 0.1;
	const delta = event.deltaY > 0 ? -zoomSpeed : zoomSpeed;
	const newZoom = Math.max(0.1, Math.min(5, currentZoom + delta));

	if (newZoom !== currentZoom) {
		currentZoom = newZoom;
		updateZoom();
		showZoomIndicator();
	}
}

function updateZoom() {
	const primaryMedia = getPrimaryMediaElement();
	const primarySize = getMediaDimensions(primaryMedia);
	if (!primaryMedia || !primarySize.width || !primarySize.height) return;

	// Calculate scaled dimensions
	const scaledWidth = primarySize.width * currentZoom;
	const scaledHeight = primarySize.height * currentZoom;

	if (currentZoom === 1) {
		// At 100%, fit to viewport
		primaryMedia.style.width = 'auto';
		primaryMedia.style.height = 'auto';
		primaryMedia.style.maxWidth = '100%';
		primaryMedia.style.maxHeight = '100%';
	} else {
		// When zoomed, set explicit dimensions
		primaryMedia.style.width = scaledWidth + 'px';
		primaryMedia.style.height = scaledHeight + 'px';
		primaryMedia.style.maxWidth = 'none';
		primaryMedia.style.maxHeight = 'none';
	}

	// Also update second media if in dual-page mode
	const secondaryMedia = getSecondaryMediaElement();
	const secondarySize = getMediaDimensions(secondaryMedia);
	if (dualPageMode && secondaryMedia && secondarySize.width && secondarySize.height) {
		const scaledWidth2 = secondarySize.width * currentZoom;
		const scaledHeight2 = secondarySize.height * currentZoom;

		if (currentZoom === 1) {
			secondaryMedia.style.width = 'auto';
			secondaryMedia.style.height = 'auto';
			secondaryMedia.style.maxWidth = '100%';
			secondaryMedia.style.maxHeight = '100%';
		} else {
			secondaryMedia.style.width = scaledWidth2 + 'px';
			secondaryMedia.style.height = scaledHeight2 + 'px';
			secondaryMedia.style.maxWidth = 'none';
			secondaryMedia.style.maxHeight = 'none';
		}
	}
}

function showZoomIndicator() {
	const percentage = Math.round(currentZoom * 100);
	zoomIndicator.textContent = `${percentage}%`;
	zoomIndicator.classList.add('show');

	if (zoomIndicatorTimeout) {
		clearTimeout(zoomIndicatorTimeout);
	}

	zoomIndicatorTimeout = setTimeout(() => {
		zoomIndicator.classList.remove('show');
	}, 1500);
}

function startPan(event) {
	const primaryMedia = getPrimaryMediaElement();
	const { width } = getMediaDimensions(primaryMedia);
	if (!primaryMedia || !width) return;
	if (event.button !== 0) return; // Only left mouse button

	isPanning = true;
	startX = event.clientX;
	startY = event.clientY;
	comicViewer.style.cursor = 'grabbing';
	event.preventDefault();
}

function doPan(event) {
	if (!isPanning) return;

	event.preventDefault();
	const deltaX = event.clientX - startX;
	const deltaY = event.clientY - startY;
	panX += deltaX;
	panY += deltaY;
	startX = event.clientX;
	startY = event.clientY;
	updatePan();
}

function endPan() {
	isPanning = false;
	comicViewer.style.cursor = 'default';
}

function updatePan() {
	const imageContainer = document.querySelector('.image-container');
	if (imageContainer) {
		imageContainer.style.transform = `translate(${panX}px, ${panY}px)`;
	}
}

function recenterImage() {
	const primaryMedia = getPrimaryMediaElement();
	const { width } = getMediaDimensions(primaryMedia);
	if (!primaryMedia || !width) return;

	// Reset zoom and pan position
	currentZoom = 1;
	panX = 0;
	panY = 0;
	updateZoom();
	updatePan();
	showZoomIndicator();
}

function fitToScreen() {
	const primaryMedia = getPrimaryMediaElement();
	const primarySize = getMediaDimensions(primaryMedia);
	if (!primaryMedia || !primarySize.width || !primarySize.height) return;

	// Calculate zoom to fit image to screen
	const viewerWidth = comicViewer.clientWidth;
	const viewerHeight = comicViewer.clientHeight;

	// Get actual canvas dimensions
	const imgWidth = primarySize.width;
	const imgHeight = primarySize.height;

	// In dual-page mode, consider both images
	let totalWidth = imgWidth;
	const secondaryMedia = getSecondaryMediaElement();
	const secondarySize = getMediaDimensions(secondaryMedia);
	if (dualPageMode && secondaryMedia && secondarySize.width) {
		totalWidth += secondarySize.width; // No gap
	}

	if (imgWidth && imgHeight) {
		// Calculate scale to fit both width and height
		const scaleX = viewerWidth / totalWidth;
		const scaleY = viewerHeight / imgHeight;

		// Use the smaller scale to ensure image fits completely
		currentZoom = Math.min(scaleX, scaleY, 1); // Don't zoom in beyond 100%
		panX = 0;
		panY = 0;
		updateZoom();
		updatePan();
		showZoomIndicator();
	}
}

function toggleAutoFit() {
	autoFitOnPageChange = !autoFitOnPageChange;
	updateAutoFitButton();
}

function updateAutoFitButton() {
	if (autoFitBtn) {
		if (autoFitOnPageChange) {
			autoFitBtn.classList.add('active');
			autoFitBtn.textContent = 'Auto: ON';
		} else {
			autoFitBtn.classList.remove('active');
			autoFitBtn.textContent = 'Auto: OFF';
		}
	}
}

function toggleDualPage() {
	dualPageMode = !dualPageMode;
	updateDualPageButton();
	updateDualPageView();
	// Refresh current page view
	showPage(currentPage);
}

function updateDualPageButton() {
	if (dualPageBtn) {
		if (dualPageMode) {
			dualPageBtn.classList.add('active');
			dualPageBtn.textContent = '2 Pages';
		} else {
			dualPageBtn.classList.remove('active');
			dualPageBtn.textContent = '1 Page';
		}
	}
}

function updateDualPageView() {
	if (!dualPageMode) {
		if (comicImage2) comicImage2.classList.add('hidden');
		if (comicVideo2) {
			comicVideo2.pause();
			comicVideo2.classList.add('hidden');
		}
	}
	updateImageOrder();
}

function toggleReadDirection() {
	leftToRight = !leftToRight;
	updateReadDirectionButton();
	updateImageOrder();
}

function updateReadDirectionButton() {
	if (readDirectionBtn) {
		if (leftToRight) {
			readDirectionBtn.classList.add('active');
			readDirectionBtn.textContent = 'L→R';
		} else {
			readDirectionBtn.classList.remove('active');
			readDirectionBtn.textContent = 'R→L';
		}
	}
}

function updateImageOrder() {
	const imageContainer = document.querySelector('.image-container');
	if (imageContainer && dualPageMode) {
		if (leftToRight) {
			// Left to right: image1, image2
			imageContainer.style.flexDirection = 'row';
		} else {
			// Right to left: image2, image1 (reverse)
			imageContainer.style.flexDirection = 'row-reverse';
		}
	} else {
		// Single page mode - reset to normal
		imageContainer.style.flexDirection = 'row';
	}
}

function toggleCoverOffset() {
	coverOffset = !coverOffset;
	updateCoverOffsetButton();
	// Refresh current page view
	showPage(currentPage);
}

function updateCoverOffsetButton() {
	if (coverOffsetBtn) {
		if (coverOffset) {
			coverOffsetBtn.classList.add('active');
			coverOffsetBtn.textContent = 'Cover: ON';
		} else {
			coverOffsetBtn.classList.remove('active');
			coverOffsetBtn.textContent = 'Cover: OFF';
		}
	}
}

function togglePreview() {
	previewPanel.classList.toggle('show');
}

function generateThumbnails() {
	if (!thumbnailGrid) return;

	thumbnailGrid.innerHTML = '';

	// Create all thumbnail elements first (fast)
	const fragment = document.createDocumentFragment();

	for (let index = 0; index < pages.length; index++) {
		const wrapper = document.createElement('div');
		wrapper.className = 'thumbnail-wrapper';

		const img = document.createElement('img');
		img.className = 'thumbnail';
		if (index === currentPage - 1) {
			img.classList.add('active');
		}

		const page = pages[index];

		// Store original data for lazy loading
		img.dataset.src = page.thumbnailSrc;
		img.dataset.type = page.type;
		img.dataset.index = index;

		// Add loading attribute
		img.loading = 'lazy';
		img.decoding = 'async';

		img.addEventListener('click', () => {
			showPage(index + 1);
			previewPanel.classList.remove('show');
		});

		const pageNum = document.createElement('div');
		pageNum.className = 'thumbnail-page';
		pageNum.textContent = index + 1;

		wrapper.appendChild(img);
		wrapper.appendChild(pageNum);
		fragment.appendChild(wrapper);
	}

	// Add all at once (faster than individual appends)
	thumbnailGrid.appendChild(fragment);

	// Use IntersectionObserver for lazy loading with batch processing
	const observer = new IntersectionObserver((entries) => {
		// Process in batches to avoid blocking
		requestIdleCallback(() => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					const thumbnail = entry.target;
					if (!thumbnail.src && thumbnail.dataset.src) {
						// Schedule thumbnail creation
						requestIdleCallback(() => {
							if (thumbnail.dataset.type === 'video') {
								thumbnail.src = thumbnail.dataset.src;
							} else {
								createDownscaledThumbnail(thumbnail.dataset.src, thumbnail);
							}
						}, { timeout: 2000 });
						observer.unobserve(thumbnail);
					}
				}
			}
		});
	}, {
		root: thumbnailGrid,
		rootMargin: '100px',
		threshold: 0.01
	});

	// Observe all thumbnails
	const thumbnails = thumbnailGrid.querySelectorAll('.thumbnail');
	for (const thumb of thumbnails) {
		observer.observe(thumb);
	}
}

function createDownscaledThumbnail(src, imgElement) {
	// Create a temporary image to load the full size
	const tempImg = new Image();
	tempImg.onload = () => {
		// Create canvas for downscaling
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');

		// Calculate thumbnail size (max 150px wide)
		const maxWidth = 150;
		const scale = Math.min(1, maxWidth / tempImg.width);
		canvas.width = tempImg.width * scale;
		canvas.height = tempImg.height * scale;

		// Draw downscaled image
		ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);

		// Set as thumbnail source
		imgElement.src = canvas.toDataURL('image/jpeg', 0.7);
	};
	tempImg.src = src;
}

function updateThumbnailActive() {
	if (!thumbnailGrid) return;

	const thumbnails = thumbnailGrid.querySelectorAll('.thumbnail');
	thumbnails.forEach((thumb, index) => {
		if (index === currentPage - 1) {
			thumb.classList.add('active');
		} else {
			thumb.classList.remove('active');
		}
	});
}

async function loadCBZ(filePath) {
	try {
		loader.classList.remove('hidden');
		clearVideoElementSource(comicVideo);
		clearVideoElementSource(comicVideo2);
		revokeActiveObjectUrls();
		pages = [];

		const archiveFormat = detectArchiveFormat(filePath);
		if (archiveFormat !== 'zip' && archiveFormat !== 'rar') {
			if (archiveFormat === '7z') {
				throw new Error('This file appears to be a 7z archive. CBZ files must use ZIP format.');
			}
		}

		const archiveEntries = await getArchiveEntries(filePath, archiveFormat);

		// Filter and sort media files
		const mediaFiles = archiveEntries
			.filter(isSupportedMediaEntry)
			.sort(sortByNormalizedPath);

		// Extract media to data URLs
		for (let index = 0; index < mediaFiles.length; index++) {
			const file = mediaFiles[index];
			try {
				const page = await createPageFromZipFile(file, index + 1);
				if (page) {
					pages.push(page);
				}
			} catch (entryError) {
				console.warn(`Skipping unsupported media entry: ${normalizeZipPath(file.path)}`, entryError?.message || entryError);
			}
		}

		totalPages = pages.length;
		totalPagesSpan.textContent = totalPages;

		if (totalPages > 0) {
			currentPage = 1;
			pageInput.disabled = false;
			pageInput.max = totalPages;

			console.log('Enabling buttons - recenterBtn:', recenterBtn, 'fitBtn:', fitBtn);

			if (recenterBtn) recenterBtn.disabled = false;
			if (fitBtn) fitBtn.disabled = false;
			if (autoFitBtn) {
				autoFitBtn.disabled = false;
				updateAutoFitButton();
			}
			if (previewToggleBtn) {
				previewToggleBtn.disabled = false;
				generateThumbnails();
			}
			if (dualPageBtn) {
				dualPageBtn.disabled = false;
				updateDualPageButton();
			}
			if (coverOffsetBtn) {
				coverOffsetBtn.disabled = false;
				updateCoverOffsetButton();
			}
			if (readDirectionBtn) {
				readDirectionBtn.disabled = false;
				updateReadDirectionButton();
			} console.log('Buttons state after enabling:', {
				recenterDisabled: recenterBtn?.disabled,
				fitDisabled: fitBtn?.disabled
			}); showPage(1);
		} else {
			throw new Error('No supported images or videos found in CBZ file');
		} loader.classList.add('hidden');
	} catch (error) {
		console.error('Error loading CBZ:', error);
		loader.classList.add('hidden');

		let message = error?.message || 'Unknown error';
		if (message.includes('FILE_ENDED')) {
			message = 'Archive ended unexpectedly. This file may be incomplete/corrupted, or not a real ZIP-based CBZ (for example, a renamed RAR).';
		}

		alert('Failed to load CBZ file: ' + message);
	}
}

function showPage(pageNumber) {
	if (pageNumber < 1 || pageNumber > totalPages) return;

	currentPage = pageNumber;
	pageInput.value = currentPage;
	const currentPageData = pages[currentPage - 1];

	// Load the page media
	if (currentPageData) {
		renderPageToSlot(currentPageData, comicImage, comicVideo, () => {
			if (autoFitOnPageChange) {
				fitToScreen();
			}
		});

		// Load second page if in dual-page mode
		// With cover offset: page 1 shows alone, page 2+ shows in pairs (2-3, 4-5, etc.)
		// Without cover offset: pages show in pairs from start (1-2, 3-4, etc.)
		let shouldShowSecondPage = false;
		let secondPageIndex = currentPage; // Default to next page

		if (dualPageMode) {
			if (coverOffset) {
				// With cover offset: show second page only if current page is even and not the last page
				if (currentPage % 2 === 0 && currentPage < totalPages) {
					shouldShowSecondPage = true;
				}
			} else {
				// Without cover offset: show second page if not on last page
				if (currentPage < totalPages) {
					shouldShowSecondPage = true;
				}
			}
		}

		if (shouldShowSecondPage && pages[secondPageIndex]) {
			renderPageToSlot(pages[secondPageIndex], comicImage2, comicVideo2, () => {
				if (autoFitOnPageChange) {
					fitToScreen();
				} else {
					updateZoom();
				}
			});
		} else {
			resetSecondarySlot();
		}

		// Update image order based on reading direction
		updateImageOrder();

		// Preload next image after current one loads
		preloadNextImage();
	}

	updateNavigation();
	updateThumbnailActive();
}

function resetSecondarySlot() {
	if (comicImage2) {
		comicImage2.classList.add('hidden');
	}
	if (comicVideo2) {
		clearVideoElementSource(comicVideo2);
		comicVideo2.classList.add('hidden');
	}
}

function renderPageToSlot(pageData, canvasElement, videoElement, onReady) {
	if (!pageData) return;

	if (pageData.type === 'video') {
		if (canvasElement) {
			canvasElement.classList.add('hidden');
		}

		if (videoElement) {
			videoElement.pause();
			videoElement.src = pageData.src;
			videoElement.currentTime = 0;
			videoElement.classList.remove('hidden');
			videoElement.onloadedmetadata = () => {
				videoElement.play().catch(() => {
					// ignore autoplay errors
				});
				if (onReady) onReady();
			};
		}
		return;
	}

	if (videoElement) {
		clearVideoElementSource(videoElement);
		videoElement.classList.add('hidden');
	}

	const image = new Image();
	image.onload = () => {
		const context = canvasElement.getContext('2d');
		canvasElement.width = image.width;
		canvasElement.height = image.height;
		context.drawImage(image, 0, 0);
		canvasElement.classList.remove('hidden');
		if (onReady) onReady();
	};
	image.src = pageData.src;
}

function preloadNextImage() {
	// Preload the next image in the background
	if (currentPage < totalPages && pages[currentPage]?.type === 'image') {
		const preloadImg = new Image();
		preloadImg.src = pages[currentPage].src;
	}

	// Also preload previous image for smooth backward navigation
	if (currentPage > 1 && pages[currentPage - 2]?.type === 'image') {
		const preloadPrevImg = new Image();
		preloadPrevImg.src = pages[currentPage - 2].src;
	}
}

function updateNavigation() {
	prevBtn.disabled = currentPage <= 1;
	nextBtn.disabled = currentPage >= totalPages;
}

function previousPage() {
	if (currentPage > 1) {
		let step = 1;
		if (dualPageMode) {
			if (coverOffset) {
				// With cover offset: page 1 is alone, then pairs (2-3, 4-5, etc.)
				if (currentPage === 2) {
					step = 1; // Go from page 2 to page 1 (cover)
				} else {
					step = 2; // Normal dual-page step
				}
			} else {
				step = 2;
			}
		}
		showPage(Math.max(1, currentPage - step));
	}
}

function nextPage() {
	if (currentPage < totalPages) {
		let step = 1;
		if (dualPageMode) {
			if (coverOffset) {
				// With cover offset: page 1 is alone, then pairs (2-3, 4-5, etc.)
				if (currentPage === 1) {
					step = 1; // Go from page 1 to page 2 (start of first pair)
				} else {
					step = 2; // Normal dual-page step
				}
			} else {
				step = 2;
			}
		}
		showPage(Math.min(totalPages, currentPage + step));
	}
}

function goToPage() {
	const page = Number.parseInt(pageInput.value, 10);
	if (page >= 1 && page <= totalPages) {
		showPage(page);
	} else {
		pageInput.value = currentPage;
	}
}

eagle.onPluginRun(async (event) => {
	console.log('eagle.onPluginRun', event);

	// Get the selected item(s) from Eagle
	const items = await eagle.item.getSelected();

	if (items && items.length > 0) {
		const item = items[0];
		console.log('Selected item:', item);

		// Check if the file is a CBZ
		if (item.ext && item.ext.toLowerCase() === 'cbz') {
			await loadCBZ(item.filePath);
		} else {
			alert('Please select a CBZ file');
		}
	} else {
		alert('No file selected. Please select a CBZ file in Eagle.');
	}
});

eagle.onPluginShow(() => {
	console.log('eagle.onPluginShow');

	// Re-enable buttons if we have pages loaded
	if (totalPages > 0) {
		pageInput.disabled = false;
		recenterBtn.disabled = false;
		fitBtn.disabled = false;
		prevBtn.disabled = currentPage <= 1;
		nextBtn.disabled = currentPage >= totalPages;
	}
});

eagle.onPluginHide(() => {
	console.log('eagle.onPluginHide');
});

eagle.onPluginBeforeExit((event) => {
	console.log('eagle.onPluginBeforeExit');
	clearVideoElementSource(comicVideo);
	clearVideoElementSource(comicVideo2);
	revokeActiveObjectUrls();
});