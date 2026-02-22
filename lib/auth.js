/**
 * auth.js - 简单认证模块
 * 基于 config.json 中的用户列表进行认证，使用 cookie + token 管理会话
 */

const crypto = require('crypto');

class Auth {
  constructor(config) {
    // 用户列表
    this.users = new Map();
    for (const user of config.users) {
      this.users.set(user.username, user.password);
    }
    // 活跃 token 映射: token -> { username, createdAt }
    this.tokens = new Map();
    // 会话超时时间（默认1小时）
    this.sessionTimeout = config.sessionTimeout || 3600000;
  }

  /**
   * 验证用户名密码，成功返回 token，失败返回 null
   */
  login(username, password) {
    const storedPassword = this.users.get(username);
    if (!storedPassword || storedPassword !== password) {
      return null;
    }
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(token, {
      username,
      createdAt: Date.now()
    });
    return token;
  }

  /**
   * 验证 token 是否有效，返回用户名或 null
   */
  verify(token) {
    if (!token) return null;
    const session = this.tokens.get(token);
    if (!session) return null;

    // 检查是否过期
    if (Date.now() - session.createdAt > this.sessionTimeout) {
      this.tokens.delete(token);
      return null;
    }
    return session.username;
  }

  /**
   * 登出
   */
  logout(token) {
    this.tokens.delete(token);
  }

  /**
   * Express 中间件：检查认证状态
   */
  middleware() {
    return (req, res, next) => {
      const token = req.cookies?.token;
      const username = this.verify(token);
      if (!username) {
        // API 请求返回 401，页面请求重定向到登录页
        if (req.path.startsWith('/api/')) {
          return res.status(401).json({ error: '未认证' });
        }
        return res.redirect('/');
      }
      req.username = username;
      next();
    };
  }
}

module.exports = Auth;
