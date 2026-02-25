const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const unrar = require('node-unrar-js');
let heicConvert = null;

try {
    heicConvert = require('heic-convert');
} catch (error) {
    console.warn('heic-convert is not available. HEIC thumbnails will use native decode fallback.', error?.message || error);
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

function isSupportedImageEntry(file, imageExtensions) {
    if (!file || isDirectoryEntry(file)) {
        return false;
    }

    const normalizedPath = normalizeZipPath(file.path);
    const ext = getEntryExtension(file);
    return imageExtensions.includes(ext) && !normalizedPath.startsWith('__MACOSX/');
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

        return 'unknown';
    } catch (error) {
        console.warn('Failed to detect archive format for thumbnail.', error?.message || error);
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

module.exports = async ({ src, dest, item }) => {
    try {
        // Supported image extensions
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'];

        const archiveFormat = detectArchiveFormat(src);
        if (archiveFormat !== 'zip' && archiveFormat !== 'rar') {
            throw new Error('Unsupported archive format for thumbnail generation.');
        }

        // Read and extract CBZ file
        const entries = await getArchiveEntries(src, archiveFormat);

        // Filter and sort image files
        const imageFiles = entries
            .filter(file => isSupportedImageEntry(file, imageExtensions))
            .sort(sortByNormalizedPath);

        if (imageFiles.length === 0) {
            throw new Error('No images found in CBZ file');
        }

        // Extract the first image
        const firstImage = imageFiles[0];
        const ext = getEntryExtension(firstImage);
        let buffer = toNodeBuffer(await firstImage.buffer());

        if (ext === '.heic' || ext === '.heif') {
            if (heicConvert) {
                try {
                    buffer = toNodeBuffer(await heicConvert({
                        buffer,
                        format: 'JPEG',
                        quality: 0.9
                    }));
                } catch (convertError) {
                    console.warn(`HEIC thumbnail conversion failed for ${normalizeZipPath(firstImage.path)}. Falling back to native decode.`, convertError?.message || convertError);
                }
            }
        }

        // Save the thumbnail to dest
        fs.writeFileSync(dest, buffer);

        // Return the updated item
        return item;
    }
    catch (err) {
        throw err;
    }
}