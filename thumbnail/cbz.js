const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
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

module.exports = async ({ src, dest, item }) => {
    try {
        // Supported image extensions
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'];

        // Read and extract CBZ file
        const directory = await unzipper.Open.file(src);

        // Filter and sort image files
        const imageFiles = directory.files
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