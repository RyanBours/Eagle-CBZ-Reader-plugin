const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

module.exports = async ({ src, dest, item }) => {
    try {
        // Supported image extensions
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

        // Read and extract CBZ file
        const directory = await unzipper.Open.file(src);

        // Filter and sort image files
        const imageFiles = directory.files
            .filter(file => {
                const ext = path.extname(file.path).toLowerCase();
                return imageExtensions.includes(ext) && !file.path.startsWith('__MACOSX');
            })
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

        if (imageFiles.length === 0) {
            throw new Error('No images found in CBZ file');
        }

        // Extract the first image
        const firstImage = imageFiles[0];
        const buffer = await firstImage.buffer();

        // Save the thumbnail to dest
        fs.writeFileSync(dest, buffer);

        // Return the updated item
        return item;
    }
    catch (err) {
        throw err;
    }
}