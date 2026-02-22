/**
 * file-handler.js - 文件上传处理模块
 * 使用 multer 处理文件上传，保存到 uploads/ 目录
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');

class FileHandler {
    constructor(config) {
        this.uploadDir = path.resolve(config.uploadDir || './uploads');
        this.maxFileSize = config.maxFileSize || 50 * 1024 * 1024; // 默认 50MB

        // 确保上传目录存在
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }

    /**
     * 创建 multer 中间件
     */
    getMiddleware() {
        const storage = multer.diskStorage({
            destination: (req, file, cb) => {
                // 为每个用户创建独立的上传目录
                const userDir = path.join(this.uploadDir, req.username || 'anonymous');
                if (!fs.existsSync(userDir)) {
                    fs.mkdirSync(userDir, { recursive: true });
                }
                cb(null, userDir);
            },
            filename: (req, file, cb) => {
                // 保留原始文件名，如有冲突加时间戳
                const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
                const ext = path.extname(originalName);
                const base = path.basename(originalName, ext);
                const targetPath = path.join(this.uploadDir, req.username || 'anonymous', originalName);

                if (fs.existsSync(targetPath)) {
                    cb(null, `${base}-${Date.now()}${ext}`);
                } else {
                    cb(null, originalName);
                }
            }
        });

        return multer({
            storage,
            limits: {
                fileSize: this.maxFileSize
            }
        });
    }

    /**
     * 获取用户的上传文件列表
     */
    getUserFiles(username) {
        const userDir = path.join(this.uploadDir, username);
        if (!fs.existsSync(userDir)) return [];

        return fs.readdirSync(userDir).map(filename => {
            const filePath = path.join(userDir, filename);
            const stat = fs.statSync(filePath);
            return {
                name: filename,
                path: filePath,
                size: stat.size,
                createdAt: stat.birthtime
            };
        });
    }

    /**
     * 删除用户上传的文件
     */
    deleteFile(username, filename) {
        const filePath = path.join(this.uploadDir, username, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }
}

module.exports = FileHandler;
