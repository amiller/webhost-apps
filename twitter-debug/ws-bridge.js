#!/usr/bin/env node
const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { exec } = require('child_process')

const PORT = process.env.ENVOY_WS_PORT || 3000
const STATIC_DIR = process.env.ENVOY_STATIC_DIR || '/opt/envoy/web'

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
}

const commandQueue = []
const pendingCommands = new Map()
const httpPending = new Map()
const clientLogs = []
const MAX_LOGS = 200

// Focus event system — extension pushes focus events, VNC client polls for them
let focusWaiters = [] // callbacks waiting for next focus event
let lastFocusEvent = null

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Proxy /twitter/* to the in-container agent server (single image_port on the daemon).
  // Inert for images that don't run one (they simply never route /twitter/*).
  if (req.url.startsWith('/twitter/')) {
    const pr = http.request({ host: 'localhost', port: 8090, path: req.url, method: req.method, headers: req.headers },
      (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
    pr.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) })
    req.pipe(pr)
    return
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', pendingCommands: commandQueue.length, wsClients: wss.clients.size }))
    return
  }

  if (req.url === '/api/commands' && req.method === 'GET') {
    const commands = commandQueue.splice(0, commandQueue.length)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(commands))
    return
  }

  if (req.url === '/api/responses' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      console.log('[WS-Bridge] Raw response body:', body.slice(0, 500))
      try {
        const response = JSON.parse(body)
        console.log('[WS-Bridge] Parsed response id:', response.id, 'success:', response.success, 'result type:', typeof response.result, 'result:', JSON.stringify(response.result).slice(0, 200))
        // Try HTTP pending first, then WS
        const httpCb = httpPending.get(response.id)
        if (httpCb) {
          httpCb(response)
          console.log('[WS-Bridge] Sent HTTP response:', response.id)
        } else {
          const ws = pendingCommands.get(response.id)
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(response))
            console.log('[WS-Bridge] Sent WS response:', response.id)
            pendingCommands.delete(response.id)
          } else {
            console.log('[WS-Bridge] Client gone for:', response.id)
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  if (req.url === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(clientLogs))
    return
  }
  if (req.url === '/api/logs' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const entry = JSON.parse(body)
        clientLogs.push({ t: Date.now(), ...entry })
        if (clientLogs.length > MAX_LOGS) clientLogs.shift()
      } catch {}
      res.writeHead(200); res.end('ok')
    })
    return
  }

  // Focus event from extension content script
  if (req.url === '/api/focus' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const event = JSON.parse(body)
        console.log('[WS-Bridge] Focus event:', event.placeholder || event.type || 'unknown')
        lastFocusEvent = event
        // Notify all waiting long-pollers
        for (const cb of focusWaiters) cb(event)
        focusWaiters = []
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }

  // Long-poll for focus events (VNC client waits here)
  if (req.url === '/api/focus' && req.method === 'GET') {
    const timeout = setTimeout(() => {
      focusWaiters = focusWaiters.filter(cb => cb !== respond)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('null')
    }, 30000)
    const respond = (event) => {
      clearTimeout(timeout)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(event))
    }
    focusWaiters.push(respond)
    return
  }

  // HTTP bridge command — post command, wait for extension response
  if (req.url === '/api/bridge' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const command = JSON.parse(body)
        const id = command.id || 'h-' + Date.now().toString(36)
        command.id = id

        if (command.tool === 'log') {
          const msg = command.args?.[0] || ''
          clientLogs.push({ t: Date.now(), msg })
          if (clientLogs.length > MAX_LOGS) clientLogs.shift()
          console.log('[Client]', msg)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id, success: true }))
          return
        }

        if (command.tool === 'restart') {
          console.log('[WS-Bridge] New session via extension (browsingData.remove + navigate)')
          command.tool = 'newSession'
          command.args = command.args || ['https://www.tiktok.com/login/phone-or-email/email']
          commandQueue.push(command)
          const timeout = setTimeout(() => {
            httpPending.delete(id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id, success: false, error: 'timeout' }))
          }, 20000)
          httpPending.set(id, (response) => {
            clearTimeout(timeout)
            httpPending.delete(id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(response))
          })
          return
        }

        console.log('[WS-Bridge] HTTP Command:', command.tool, id)
        commandQueue.push(command)

        // Poll for response with timeout
        const timeout = setTimeout(() => {
          httpPending.delete(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id, success: false, error: 'timeout' }))
        }, 90000)  // captureTrace/navigate can exceed 10s; the extension replies when done

        httpPending.set(id, (response) => {
          clearTimeout(timeout)
          httpPending.delete(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        })
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  // Static file serving (web UI)
  const urlPath = req.url.split('?')[0]
  const filePath = path.join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath)
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(STATIC_DIR))) { res.writeHead(403); res.end(); return }
  try {
    const data = fs.readFileSync(resolved)
    const ext = path.extname(resolved)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  console.log('[WS-Bridge] Client connected')

  ws.on('message', (data) => {
    try {
      const command = JSON.parse(data.toString())

      if (command.tool === 'log') {
        const msg = command.args?.[0] || ''
        clientLogs.push({ t: Date.now(), msg })
        if (clientLogs.length > MAX_LOGS) clientLogs.shift()
        console.log('[Client]', msg)
        return
      }

      if (command.tool === 'restart') {
        console.log('[WS-Bridge] Restarting brave...')
        exec('supervisorctl restart brave', (err, stdout, stderr) => {
          ws.send(JSON.stringify({ id: command.id, success: !err, result: stdout.trim(), error: err ? stderr.trim() : '' }))
        })
        return
      }

      console.log('[WS-Bridge] Command:', command.tool, command.id)
      commandQueue.push(command)
      pendingCommands.set(command.id, ws)
    } catch (e) {
      console.error('[WS-Bridge] Invalid JSON:', e.message)
    }
  })

  ws.on('close', () => {
    console.log('[WS-Bridge] Client disconnected')
  })

  ws.on('error', (e) => {
    console.error('[WS-Bridge] Socket error:', e.message)
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WS-Bridge] Server listening on port ${PORT}`)
  console.log(`[WS-Bridge] WebSocket: ws://0.0.0.0:${PORT}/ws`)
  console.log(`[WS-Bridge] Extension API: http://0.0.0.0:${PORT}/api/commands`)
  console.log(`[WS-Bridge] Health: http://0.0.0.0:${PORT}/health`)
})
