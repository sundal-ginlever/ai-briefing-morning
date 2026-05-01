// src/index.js  (Phase 2)
// Express-free HTTP 서버.
//   /health         → Railway 헬스체크
//   /api/*          → Phase 2 REST API (JWT 인증)
//   /               → 관리 대시보드 (HTML)

import 'dotenv/config'
import { createServer }      from 'http'
import { handleApiRequest }  from './api/router.js'
import { logger }            from './utils/logger.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT ?? 3000

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

async function serveStaticFile(req, res, reqPath) {
  try {
    if (reqPath === '/') reqPath = '/index.html'
    
    // Path traversal protection
    const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '')
    const filePath = path.join(__dirname, '../public', safePath)
    
    const stat = await fs.stat(filePath)
    if (stat.isFile()) {
      const ext = path.extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' })
      const data = await fs.readFile(filePath)
      return res.end(data)
    }
  } catch (err) {
    // If not found, ignore to return 404 below
  }
  
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
}

function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  // Basic CSP (Content Security Policy)
  res.setHeader('Content-Security-Policy', "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval';")
  
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

const server = createServer(async (req, res) => {
  addSecurityHeaders(res)
  
  // Preflight requests for CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  const pathName = new URL(req.url, 'http://localhost').pathname

  if (pathName === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }))
  }

  if (pathName.startsWith('/api/')) return handleApiRequest(req, res)

  // 그 외 → public/ 정적 파일 서빙
  return serveStaticFile(req, res, pathName)
})

server.listen(PORT, () => {
  logger.info(`[server] Morning Briefing running on port ${PORT}`)
  logger.info(`[server] Dashboard → http://localhost:${PORT}`)
})
