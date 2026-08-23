# server.ps1 — Zero-dependency static file server for the Product Order
# Monitoring System. Written in pure PowerShell (uses only .NET classes that
# ship with Windows) because this machine has no Node.js or Python runtime
# installed. Serving over http://localhost is required (not file://) so
# that ES module imports and IndexedDB work correctly in the browser —
# Chromium blocks module script fetches and treats storage differently on
# the file:// origin.
#
# Uses a raw TcpListener (not System.Net.HttpListener/http.sys) so it does
# NOT require Administrator rights or a URL ACL reservation — a plain
# socket bind to loopback works for any user.
#
# Two reliability properties that were missing in the first version and
# caused a real hang during QA: (1) every socket read has a timeout, so a
# connection that never sends a complete request (a stalled keep-alive probe,
# a browser speculative preconnect, ...) can't block the server forever;
# (2) each connection is handled in its own runspace, so a slow client
# can't stall requests from other tabs/resources behind it.

param(
  [int]$Port = 8080
)

# IMPORTANT: this whole script body is wrapped in try/catch/finally below.
# Double-clicking a .ps1 in Windows Explorer runs it in a PowerShell window
# that closes THE INSTANT the script stops — including the instant an
# unhandled exception is thrown — with no pause, so any startup error
# (most commonly "port already in use" from a previous instance that
# hadn't released it yet) was invisible: the window would just vanish and
# it looked like the server "closed itself for no reason". Every exit path
# now prints what happened and waits for a keypress before the window can
# close, so the actual cause is always visible.

$root = $PSScriptRoot

try {
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "===============================================================" -ForegroundColor Red
  Write-Host " Server failed to start on port $Port." -ForegroundColor Red
  Write-Host " Reason: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  Write-Host " The most common cause: another copy of this server (or some" -ForegroundColor Yellow
  Write-Host " other app) is already using port $Port. Close any other" -ForegroundColor Yellow
  Write-Host " 'Order Monitor server' PowerShell windows and try again, or" -ForegroundColor Yellow
  Write-Host " run this script with a different port:" -ForegroundColor Yellow
  Write-Host "   powershell -File server.ps1 -Port 8081" -ForegroundColor Yellow
  Write-Host "===============================================================" -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to close this window"
  exit 1
}

Write-Host "Order Monitor server running at http://localhost:$Port/  (root: $root)"
Write-Host "Keep this window open while using the app. Press Ctrl+C to stop." -ForegroundColor DarkGray

$mimeMap = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.csv'  = 'text/csv; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.png'  = 'image/png'
  '.map'  = 'application/json; charset=utf-8'
}

$handleClient = {
  param($client, $root, $mimeMap)

  function Get-MimeType([string]$ext) {
    if ($mimeMap.ContainsKey($ext)) { return $mimeMap[$ext] }
    return 'application/octet-stream'
  }

  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 5000
    $stream = $client.GetStream()
    $stream.ReadTimeout = 5000
    $stream.WriteTimeout = 5000

    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
    $requestLine = $reader.ReadLine()
    # Drain remaining request headers (we don't need them for GET of static files).
    while (-not [string]::IsNullOrEmpty($reader.ReadLine())) {}

    if ([string]::IsNullOrWhiteSpace($requestLine)) {
      $client.Close()
      return
    }

    $parts = $requestLine.Split(' ')
    $method = $parts[0]
    $rawPath = if ($parts.Length -gt 1) { $parts[1] } else { '/' }
    $path = $rawPath.Split('?')[0]
    $path = [System.Uri]::UnescapeDataString($path)
    if ($path -eq '/') { $path = '/index.html' }

    # Prevent path traversal outside the project root.
    $fullPath = Join-Path $root ($path.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar))
    $resolved = $null
    try { $resolved = (Resolve-Path -LiteralPath $fullPath -ErrorAction Stop).Path } catch {}

    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
    $writer.AutoFlush = $true

    if ($method -ne 'GET' -and $method -ne 'HEAD') {
      $body = [System.Text.Encoding]::UTF8.GetBytes('405 Method Not Allowed')
      $writer.Write("HTTP/1.1 405 Method Not Allowed`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
      if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }
    }
    elseif (-not $resolved -or -not $resolved.StartsWith($root) -or (Test-Path $resolved -PathType Container)) {
      $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $writer.Write("HTTP/1.1 404 Not Found`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
      if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }
    }
    else {
      $bytes = [System.IO.File]::ReadAllBytes($resolved)
      $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
      $mime = Get-MimeType $ext
      # no-store (not just no-cache): during active development the browser
      # was observed serving a stale cached module even right after a fresh
      # navigation, because no-cache alone permits reuse once a validator
      # is present and this server sends none. no-store forbids caching the
      # response at all, which is the right trade-off for a local dev tool
      # where "did my edit actually apply?" must always be true.
      $header = "HTTP/1.1 200 OK`r`nContent-Type: $mime`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store, no-cache, must-revalidate`r`nPragma: no-cache`r`nConnection: close`r`n`r`n"
      $writer.Write($header)
      if ($method -ne 'HEAD') { $stream.Write($bytes, 0, $bytes.Length) }
    }

    $stream.Flush()
  } catch {
    # Any timeout / reset / malformed request ends this one connection only —
    # never the accept loop.
  } finally {
    try { $client.Close() } catch {}
  }
}

$pool = [runspacefactory]::CreateRunspacePool(1, 16)
$pool.Open()
$inFlight = New-Object System.Collections.Generic.List[object]

# Everything below is wrapped so that no matter HOW this loop ends —
# Ctrl+C, the listener erroring out, or a bug — the window stays open
# with a visible message instead of just vanishing (see the comment at
# the top of this file for why that mattered).
try {
  while ($true) {
    try {
      $client = $listener.AcceptTcpClient()
    } catch {
      Write-Host "Listener stopped: $($_.Exception.Message)" -ForegroundColor Red
      break
    }

    $ps = [powershell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($handleClient).AddArgument($client).AddArgument($root).AddArgument($mimeMap)
    $handle = $ps.BeginInvoke()
    $inFlight.Add(@{ ps = $ps; handle = $handle })

    # Reap completed handlers so the list doesn't grow unbounded over a long-running session.
    if ($inFlight.Count -gt 64) {
      $stillRunning = New-Object System.Collections.Generic.List[object]
      foreach ($item in $inFlight) {
        if ($item.handle.IsCompleted) {
          try { $item.ps.EndInvoke($item.handle) } catch {}
          $item.ps.Dispose()
        } else {
          $stillRunning.Add($item)
        }
      }
      $inFlight = $stillRunning
    }
  }
} catch {
  Write-Host ""
  Write-Host "Server stopped unexpectedly: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  try { $listener.Stop() } catch {}
  Write-Host ""
  Write-Host "Server stopped." -ForegroundColor Yellow
  Read-Host "Press Enter to close this window"
}
