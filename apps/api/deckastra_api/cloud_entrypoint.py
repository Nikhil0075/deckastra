"""Cloud Run entrypoints, including a health server for the background poller."""
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    if os.environ.get("DECKASTRA_SERVICE", "api") != "export-worker":
        import uvicorn
        uvicorn.run("deckastra_api.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
        return
    from .export_worker import main as poll
    # A dead poller must fail the health probe, so Cloud Run restarts it.
    worker = threading.Thread(target=poll, name="export-poller", daemon=True)
    worker.start()

    class Health(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in ("/health", "/ready"):
                self.send_error(404)
                return
            self.send_response(200 if worker.is_alive() else 503)
            self.end_headers()
            self.wfile.write(b"ok" if worker.is_alive() else b"worker stopped")

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Health)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    server.serve_forever()


if __name__ == "__main__":
    main()
