"""
NovaStream Cinema Pro - Dedicated High Performance IPTV Streaming Server & Proxy
Features:
- Instant CORS & Mixed Content Bypass for HLS (.m3u8) & Video Chunks (.ts)
- Cross-device LAN streaming (PC, Mobile, Tablet, Smart TV)
- Automatic LAN IP detection
"""

import sys, os, re, json, urllib.request, urllib.parse, socket, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

sys.stdout.reconfigure(encoding='utf-8')

PORT = int(os.environ.get('PORT', 5000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_STREAM_HEADERS = {
    'User-Agent': 'TiviMate/4.7.0 (Linux; Android 11)',
    'Referer': 'https://tataplaym3u.zonmp.net/',
    'Origin': 'https://tataplaym3u.zonmp.net',
    'Accept': '*/*'
}

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

class CinemaServerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Accept-Encoding, User-Agent')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Stream Manifest Proxy (.m3u8)
        if path == '/proxy/stream':
            self.handle_proxy_stream(query)
            return

        # 2. Stream Video Chunk Proxy (.ts)
        if path == '/proxy/ts':
            self.handle_proxy_ts(query)
            return

        # 3. Fallback: Serve static UI files
        if path == '/' or path == '/index.html':
            self.path = '/index.html'

        super().do_GET()

    def handle_proxy_stream(self, query):
        stream_url = query.get('url', [None])[0]
        if not stream_url:
            self.send_error(400, "Missing stream url")
            return

        try:
            req = urllib.request.Request(stream_url, headers=DEFAULT_STREAM_HEADERS)
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw_m3u8 = resp.read().decode('utf-8', errors='ignore')

                if '#EXTM3U' not in raw_m3u8 and '#EXTINF' not in raw_m3u8:
                    self.send_response(503)
                    self.send_header('Content-Type', 'text/plain')
                    self.end_headers()
                    self.wfile.write(b"Upstream stream temporarily busy or offline")
                    return

                base_url = stream_url.rsplit('/', 1)[0] + '/'
                rewritten_lines = []

                for line in raw_m3u8.splitlines():
                    stripped = line.strip()
                    if not stripped:
                        continue
                    if stripped.startswith('#'):
                        if stripped.startswith('#EXT-X-KEY'):
                            m_uri = re.search(r'URI="([^"]*)"', stripped)
                            if m_uri:
                                key_url = urllib.parse.urljoin(base_url, m_uri.group(1))
                                proxy_key = f'/proxy/ts?url={urllib.parse.quote(key_url)}'
                                stripped = stripped.replace(m_uri.group(1), proxy_key)
                        rewritten_lines.append(stripped)
                    else:
                        full_ts = stripped if stripped.startswith('http') else urllib.parse.urljoin(base_url, stripped)
                        rewritten_lines.append(f'/proxy/ts?url={urllib.parse.quote(full_ts)}')

                output_content = '\n'.join(rewritten_lines).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
                self.send_header('Content-Length', str(len(output_content)))
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.end_headers()
                self.wfile.write(output_content)

        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(f"Proxy error: {str(e)}".encode('utf-8'))

    def handle_proxy_ts(self, query):
        ts_url = query.get('url', [None])[0]
        if not ts_url:
            self.send_error(400, "Missing ts url")
            return

        try:
            req_headers = {'User-Agent': DEFAULT_STREAM_HEADERS['User-Agent'], 'Accept': '*/*'}
            client_range = self.headers.get('Range')
            if client_range:
                req_headers['Range'] = client_range

            req = urllib.request.Request(ts_url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=12) as resp:
                status_code = resp.getcode()
                self.send_response(status_code)

                for h in ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']:
                    val = resp.headers.get(h)
                    if val:
                        self.send_header(h, val)

                self.send_header('Cache-Control', 'public, max-age=30')
                self.end_headers()

                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except Exception:
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass

def run():
    server_address = ('0.0.0.0', PORT)
    httpd = ThreadingHTTPServer(server_address, CinemaServerHandler)
    local_ip = get_local_ip()

    print("=" * 65)
    print("      NOVASTREAM CINEMA PRO - LIVE TV & EPG SCHEDULE SERVER")
    print("=" * 65)
    print(f"  * Local PC Access  : http://localhost:{PORT}")
    print(f"  * Mobile / Wi-Fi   : http://{local_ip}:{PORT}")
    print("=" * 65)
    print("Server is active! Press Ctrl + C to stop.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.shutdown()

if __name__ == '__main__':
    run()
