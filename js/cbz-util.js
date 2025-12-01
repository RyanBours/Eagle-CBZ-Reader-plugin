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

const loadByIndex = async (dir, index) => {
    return new Promise(async (resolve, reject) => {
        try {
            let currentIndex = 0;
            fs.createReadStream(dir)
                .pipe(unzipper.Parse())
                .pipe(etl.map(entry => {
                    if (image_extensions.test(entry.path)) {
                        if (currentIndex === index) {
                            return entry.buffer().then(buffer => {
                                const imageData = `data:image/png;base64,${buffer.toString('base64')}`;
                                return resolve(imageData);
                            });
                        }
                        currentIndex++;
                        entry.autodrain();
                    } else {
                        entry.autodrain();
                    }
                }))
                .on('finish', () => {
                    return reject(new Error('Index out of bounds'));
                });
        } catch (err) {
            return reject(err);
        }
    });
}

const readZipEntries = async (dir) => {
    return new Promise(async (resolve, reject) => {
        try {
            let entries = [];
            fs.createReadStream(dir)
                .pipe(unzipper.Parse())
                .on('entry', entry => {
                    entries.push(entry.path);
                    entry.autodrain();
                })
                .on('close', () => {
                    return resolve(entries);
                });
        } catch (err) {
            return reject(err);
        }
    });
}

const logmsg = (msg) => {
    console.log(`[cbz-util] ${msg}`);
}

module.exports = {
    load,
    loadByIndex,
    readZipEntries,
    logmsg
}