import Config from "../config";
import path from "path";
import fs from "fs";
import fileType from "file-type";
import readChunk from "read-chunk";
import isUtf8 from "is-utf8";
import log from "../log";
import contentDisposition from "content-disposition";
import type { Socket } from "socket.io";
import { Request, Response, NextFunction } from "express";
import Client from "../client";
import resolvePath from "resolve-path";
import multer from "multer";
import { nanoid } from "nanoid";
import sharp from "sharp";

declare module 'express' {
	interface Request {
		_username?: string
	}
}

// Map of allowed mime types to their respecive default filenames
// that will be rendered in browser without forcing them to be downloaded
const inlineContentDispositionTypes = {
	"application/ogg": "media.ogx",
	"audio/midi": "audio.midi",
	"audio/mpeg": "audio.mp3",
	"audio/ogg": "audio.ogg",
	"audio/vnd.wave": "audio.wav",
	"audio/x-flac": "audio.flac",
	"audio/x-m4a": "audio.m4a",
	"image/bmp": "image.bmp",
	"image/gif": "image.gif",
	"image/jpeg": "image.jpg",
	"image/png": "image.png",
	"image/webp": "image.webp",
	"image/avif": "image.avif",
	"image/jxl": "image.jxl",
	"text/plain": "text.txt",
	"video/mp4": "video.mp4",
	"video/ogg": "video.ogv",
	"video/webm": "video.webm",
};

// Multer storage backend adapted from DiskStorage https://github.com/expressjs/multer/blob/master/storage/disk.js
// To be able to transparently convert files if needed

type FilenameFunc = (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => void;
type DestinationFunc = (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => void;

class SharpDiskStorage implements multer.StorageEngine {
	getFilename: FilenameFunc;
	getDestination: DestinationFunc;

	constructor(opts: {filename: FilenameFunc, destination: DestinationFunc}) {
		this.getFilename = opts.filename;
		this.getDestination = opts.destination;
	}

	_handleFile(req: Request, file: Express.Multer.File, callback: (error?: any, info?: Partial<Express.Multer.File> | undefined) => void): void {
		const that = this;

		that.getDestination(req, file, function (err, destination) {
			if (err) {
				return callback(err);
			}

			that.getFilename(req, file, function (err2, filename) {
				if (err2) {
					return callback(err2);
				}

				let convertToJpeg = false;

				if (path.parse(filename).ext.toLowerCase() === ".heic") {
					convertToJpeg = true;
					filename.replace(/\.heic$/, ".jpg");
				}

				const finalPath = path.join(destination, filename);
				const outStream = fs.createWriteStream(finalPath);
				outStream.on("error", callback);

				if (convertToJpeg) {
					const converterStream = sharp()
						.rotate()
						.toFormat("jpeg");

					converterStream.on("error", callback);
					file.stream.pipe(converterStream).pipe(outStream);
				} else {
					file.stream.pipe(outStream);
				}

				outStream.on("finish", () => {
					callback(null, {
						destination,
						filename,
						path: finalPath,
						size: outStream.bytesWritten
					})
				});
			})
		})
	}

	_removeFile(req: Request, file: Express.Multer.File, callback: (error: Error | null) => void): void {
		const p = file.path;
		// delete file.destination;
		// delete file.filename;
		// delete file.path;

		fs.unlink(p, callback);
	}
}

interface UploadToken {
	name: string,
	timeout: NodeJS.Timeout,
};

const uploadTokens = new Map<string, UploadToken>();

class Uploader {
	constructor(client: Client, socket: Socket) {
		socket.on("upload:auth", () => {
			const token = nanoid();

			socket.emit("upload:auth", token);

			// Invalidate the token in one minute
			const timeout = Uploader.createTokenTimeout(token);

			uploadTokens.set(token, {
				name: client.name,
				timeout,
			});
		});

		socket.on("upload:ping", (token) => {
			if (typeof token !== "string") {
				return;
			}

			const storedToken = uploadTokens.get(token);

			if (!storedToken) {
				return;
			}

			clearTimeout(storedToken.timeout);
			storedToken.timeout = Uploader.createTokenTimeout(token);
		});
	}

	static createTokenTimeout(this: void, token: string) {
		return setTimeout(() => uploadTokens.delete(token), 60 * 1000);
	}

	// TODO: type
	static router(this: void, express: any) {
		express.get("/uploads/:nick/:mediaId/:slug*?", Uploader.routeGetFile);
		express.post("/uploads/new/:token",
			Uploader.consumeToken,
			Uploader.uploadMiddleware,
			Uploader.afterUpload
		);
	}

	static async routeGetFile(this: void, req: Request, res: Response) {
		const { nick, mediaId } = req.params;

		const uploadPath = Config.getFileUploadPath();

		const unsafePath = path.join(nick, mediaId);

		let filePath, detectedMimeType;

		try {
			filePath = resolvePath(uploadPath, unsafePath);
			detectedMimeType = await Uploader.getFileType(filePath);
		} catch (err: any) {
			log.error("uploaded file access error: %s", err.message);
			return res.status(404).send("Not found");
		}

		// doesn't exist
		if (detectedMimeType === null) {
			return res.status(404).send("Not found");
		}

		// Force a download in the browser if it's not an allowed type (binary or otherwise unknown)
		let slug = req.params.slug;
		const isInline = detectedMimeType in inlineContentDispositionTypes;
		let disposition = isInline ? "inline" : "attachment";

		if (!slug && isInline) {
			slug = inlineContentDispositionTypes[detectedMimeType];
		}

		if (slug) {
			disposition = contentDisposition(slug.trim(), {
				fallback: false,
				type: disposition,
			});
		}

		// Send a more common mime type for audio files
		// so that browsers can play them correctly
		if (detectedMimeType === "audio/vnd.wave") {
			detectedMimeType = "audio/wav";
		} else if (detectedMimeType === "audio/x-flac") {
			detectedMimeType = "audio/flac";
		} else if (detectedMimeType === "audio/x-m4a") {
			detectedMimeType = "audio/mp4";
		} else if (detectedMimeType === "video/quicktime") {
			detectedMimeType = "video/mp4";
		}

		res.setHeader("Content-Disposition", disposition);
		res.contentType(detectedMimeType);

		// using unsafePath because it's safely resolved against 'root' by sendFile
		return res.sendFile(unsafePath, {
			root: uploadPath,
			maxAge: 86400
		});
	}

	static consumeToken(this: void, req: Request, res: Response, next: NextFunction) {
		// if the authentication token is incorrect, bail out
		const storedToken = uploadTokens.get(req.params.token);

		if (storedToken === undefined) {
			return res.status(400).json({ error: "Invalid upload token" });
		}

		uploadTokens.delete(req.params.token);
		req._username = storedToken.name;

		next();
	}

	static uploadMiddleware(this: void, req: Request, res: Response, next: NextFunction) {
		if (req._username === undefined) {
			return res.status(400).json({ error: "Upload token has no associated user" });
		}

		const username = req._username;
		const uploadPath = Config.getFileUploadPath();

		const userDir = resolvePath(uploadPath, username);

		const uploadMiddleware = multer({
			limits: {
				files: 1,
				fileSize: Uploader.getMaxFileSize()
			},
			storage: new SharpDiskStorage({
				destination(_req, file, cb) {
					fs.promises.mkdir(userDir, { recursive: true }).then(() => {
						cb(null, userDir);
					}).catch((err) => {
						log.error("File upload error: %s", err.message);
						cb(err, "");
					});
				},
				filename(_req, file, cb) {
					let id = nanoid(16);
					const ext = path.parse(file.originalname).ext;

					if (ext) {
						id += ext;
					}

					cb(null, id);
				}
			})
			// storage: multer.diskStorage({
			// 	destination(_req, file, cb) {
			// 		fs.promises.mkdir(userDir, { recursive: true }).then(() => {
			// 			cb(null, userDir);
			// 		}).catch((err) => {
			// 			log.error("File upload error: %s", err.message);
			// 			cb(err, "");
			// 		});
			// 	},
			// 	filename(_req, file, cb) {
			// 		let id = nanoid(16);
			// 		const ext = path.parse(file.originalname).ext;

			// 		if (ext) {
			// 			id += ext;
			// 		}

			// 		cb(null, id);
			// 	}
			// })
		});

		uploadMiddleware.single("file")(req, res, next);
	}

	static afterUpload(this: void, req: Request, res: Response) {
		if (req.file === undefined) {
			return res.status(500).json({error: "File upload error"});
		}

		const relativePath = path.relative(Config.getFileUploadPath(), req.file.path);
		const uploadUrl = `uploads/${relativePath}`;

		log.info(`File upload by ${req._username ?? "unknown"}: ${relativePath}`);

		return res.status(200).json({
			url: uploadUrl
		});
	}

	static getMaxFileSize() {
		const configOption = Config.values.fileUpload.maxFileSize;

		// Busboy uses Infinity to allow unlimited file size
		if (configOption < 1) {
			return Infinity;
		}

		// maxFileSize is in bytes, but config option is passed in as KB
		return configOption * 1024;
	}

	// Returns null if an error occurred (e.g. file not found)
	// Returns a string with the type otherwise
	static async getFileType(filePath: string) {
		try {
			const buffer = await readChunk(filePath, 0, 5120);

			// returns {ext, mime} if found, null if not.
			const file = await fileType.fromBuffer(buffer);

			// if a file type was detected correctly, return it
			if (file) {
				return file.mime;
			}

			// if the buffer is a valid UTF-8 buffer, use text/plain
			if (isUtf8(buffer)) {
				return "text/plain";
			}

			// otherwise assume it's random binary data
			return "application/octet-stream";
		} catch (e: any) {
			if (e.code !== "ENOENT") {
				log.warn(`Failed to read ${filePath}: ${e.message}`);
			}
		}

		return null;
	}
}

export default Uploader;
