import http.server, socketserver, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", 8090), http.server.SimpleHTTPRequestHandler) as s:
    s.serve_forever()
