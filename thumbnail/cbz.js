const fs = require('fs');
const cbz = require('./../js/cbz-util.js');

module.exports = async ({ src, dest, item }) => {
    return new Promise(async (resolve, reject) => {
        try {
            // load thumbnail from cbz as base64 string
            const { thumbnail } = await cbz.load(src);

            // save the thumbnail to dest
            fs.writeFileSync(dest, Buffer.from(thumbnail.split(',')[1], 'base64'));

            // update the item thumbnail
            return resolve(item);
        }
        catch (err) {
            return reject(err);
        }
    });
}