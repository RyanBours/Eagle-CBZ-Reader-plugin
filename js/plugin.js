const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');

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

function handleZoom(event) {
	if (!comicImage.width || comicImage.classList.contains('hidden')) return;

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
	if (!comicImage.width || !comicImage.height) return;

	// Calculate scaled dimensions
	const scaledWidth = comicImage.width * currentZoom;
	const scaledHeight = comicImage.height * currentZoom;

	if (currentZoom === 1) {
		// At 100%, fit to viewport
		comicImage.style.width = 'auto';
		comicImage.style.height = 'auto';
		comicImage.style.maxWidth = '100%';
		comicImage.style.maxHeight = '100%';
	} else {
		// When zoomed, set explicit dimensions
		comicImage.style.width = scaledWidth + 'px';
		comicImage.style.height = scaledHeight + 'px';
		comicImage.style.maxWidth = 'none';
		comicImage.style.maxHeight = 'none';
	}

	// Also update second canvas if in dual-page mode
	if (dualPageMode && !comicImage2.classList.contains('hidden') && comicImage2.width && comicImage2.height) {
		const scaledWidth2 = comicImage2.width * currentZoom;
		const scaledHeight2 = comicImage2.height * currentZoom;

		if (currentZoom === 1) {
			comicImage2.style.width = 'auto';
			comicImage2.style.height = 'auto';
			comicImage2.style.maxWidth = '100%';
			comicImage2.style.maxHeight = '100%';
		} else {
			comicImage2.style.width = scaledWidth2 + 'px';
			comicImage2.style.height = scaledHeight2 + 'px';
			comicImage2.style.maxWidth = 'none';
			comicImage2.style.maxHeight = 'none';
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
	if (!comicImage.width || comicImage.classList.contains('hidden')) return;
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
	if (!comicImage.width || comicImage.classList.contains('hidden')) return;

	// Reset zoom and pan position
	currentZoom = 1;
	panX = 0;
	panY = 0;
	updateZoom();
	updatePan();
	showZoomIndicator();
}

function fitToScreen() {
	if (!comicImage.width || comicImage.classList.contains('hidden')) return;

	// Calculate zoom to fit image to screen
	const viewerWidth = comicViewer.clientWidth;
	const viewerHeight = comicViewer.clientHeight;

	// Get actual canvas dimensions
	const imgWidth = comicImage.width;
	const imgHeight = comicImage.height;

	// In dual-page mode, consider both images
	let totalWidth = imgWidth;
	if (dualPageMode && !comicImage2.classList.contains('hidden') && comicImage2.width) {
		totalWidth += comicImage2.width; // No gap
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
	if (dualPageMode) {
		comicImage2.classList.remove('hidden');
	} else {
		comicImage2.classList.add('hidden');
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

		// Store original data for lazy loading
		img.dataset.src = pages[index];
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
							createDownscaledThumbnail(thumbnail.dataset.src, thumbnail);
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
		pages = [];

		// Supported image extensions
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

		// Read and extract CBZ file
		const directory = await unzipper.Open.file(filePath);

		// Filter and sort image files
		const imageFiles = directory.files
			.filter(file => {
				const ext = path.extname(file.path).toLowerCase();
				return imageExtensions.includes(ext) && !file.path.startsWith('__MACOSX');
			})
			.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

		// Extract images to base64
		for (const file of imageFiles) {
			const buffer = await file.buffer();
			const ext = path.extname(file.path).toLowerCase().substring(1);
			const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
			const base64 = buffer.toString('base64');
			pages.push(`data:${mimeType};base64,${base64}`);
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
			throw new Error('No images found in CBZ file');
		} loader.classList.add('hidden');
	} catch (error) {
		console.error('Error loading CBZ:', error);
		loader.classList.add('hidden');
		alert('Failed to load CBZ file: ' + error.message);
	}
}

function showPage(pageNumber) {
	if (pageNumber < 1 || pageNumber > totalPages) return;

	currentPage = pageNumber;
	pageInput.value = currentPage;

	// Load the page image(s)
	if (pages[currentPage - 1]) {
		// Load first image onto canvas
		const img1 = new Image();
		img1.onload = () => {
			const ctx = comicImage.getContext('2d');
			comicImage.width = img1.width;
			comicImage.height = img1.height;
			ctx.drawImage(img1, 0, 0);
			comicImage.classList.remove('hidden');

			if (autoFitOnPageChange) {
				fitToScreen();
			}
		};
		img1.src = pages[currentPage - 1];

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
			const img2 = new Image();
			img2.onload = () => {
				const ctx2 = comicImage2.getContext('2d');
				comicImage2.width = img2.width;
				comicImage2.height = img2.height;
				ctx2.drawImage(img2, 0, 0);
				comicImage2.classList.remove('hidden');

				// Apply current zoom to second image
				if (autoFitOnPageChange) {
					fitToScreen();
				} else {
					updateZoom();
				}
			};
			img2.src = pages[secondPageIndex];
		} else {
			comicImage2.classList.add('hidden');
		}

		// Update image order based on reading direction
		updateImageOrder();

		// Preload next image after current one loads
		preloadNextImage();
	}

	updateNavigation();
	updateThumbnailActive();
}

function preloadNextImage() {
	// Preload the next image in the background
	if (currentPage < totalPages && pages[currentPage]) {
		const preloadImg = new Image();
		preloadImg.src = pages[currentPage];
	}

	// Also preload previous image for smooth backward navigation
	if (currentPage > 1 && pages[currentPage - 2]) {
		const preloadPrevImg = new Image();
		preloadPrevImg.src = pages[currentPage - 2];
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
});