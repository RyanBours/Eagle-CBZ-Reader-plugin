// all the utility functions to allow reading of cbz files

const fs = require('fs');
const unzipper = require('unzipper');
const etl = require('etl');
const image_extensions = /(\.png|\.jpg|\.jpeg)$/i;

const load = async (dir) => {
    return new Promise(async (resolve, reject) => {
        try {
            let cbz = {
                images: [],
                files: [],
                thumbnail: null
            }
            fs.createReadStream(dir)
                .pipe(unzipper.Parse())
                .pipe(etl.map(entry => {
                    if (image_extensions.test(entry.path)) {
                        return entry.buffer().then(buffer => {
                            cbz.files.push(entry.path);
                            cbz.images[entry.path] = `data:image/png;base64,${buffer.toString('base64')}`;
                        });
                    }
                    entry.autodrain();
                }))
                .on('finish', () => {
                    cbz.thumbnail = cbz.images[cbz.files[0]];
                    return resolve(cbz);
                });
        } catch (err) {
            return reject(err);
        }
    });
}

module.exports = {
    load
}