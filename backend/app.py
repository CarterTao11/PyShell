import os
import sys
import logging
import threading
import webbrowser

from flask import Flask, send_from_directory
from flask_cors import CORS

from config import Config
from models import db
from api import api_bp

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def create_app():
    app = Flask(__name__, static_folder=None)

    # Load config
    app.config.from_object(Config)

    # CORS
    CORS(app)

    # Initialize database
    db.init_app(app)

    # Register API blueprint
    app.register_blueprint(api_bp)

    # Static file serving for the bundled frontend
    web_dir = Config.WEB_DIR

    @app.route("/")
    def index():
        return send_from_directory(web_dir, "index.html")

    @app.route("/css/<path:filename>")
    def css_files(filename):
        return send_from_directory(os.path.join(web_dir, "css"), filename)

    @app.route("/js/<path:filename>")
    def js_files(filename):
        return send_from_directory(os.path.join(web_dir, "js"), filename)

    @app.route("/vendor/<path:filename>")
    def vendor_files(filename):
        return send_from_directory(os.path.join(web_dir, "vendor"), filename)

    # SPA fallback: all non-API routes serve index.html
    @app.route("/<path:path>")
    def spa_fallback(path):
        if path.startswith("api/"):
            return {"error": "Not found"}, 404
        return send_from_directory(web_dir, "index.html")

    return app


def _find_free_port(start: int, attempts: int = 50) -> int:
    """First free TCP port at/after `start` on the configured host."""
    import socket
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((Config.HOST, port))
                return port
            except OSError:
                continue
    return 0


def main():
    app = create_app()

    # Create tables
    with app.app_context():
        db.create_all()
        logger.info("Database tables created")
        logger.info(f"Data directory: {Config.DATA_DIR}")
        logger.info(f"Web directory:  {Config.WEB_DIR}")

    # Start the scheduled-task background thread (定时任务)
    from task_scheduler import start_scheduler
    start_scheduler(app)

    # Determine host and port:
    # - PORT env set -> use it as-is (dev workflow / explicit choice)
    # - frozen exe with no PORT -> 5173, stepping aside if occupied
    # - source run with no PORT -> 0 = random (previous behaviour)
    port = Config.PORT
    host = Config.HOST
    if not port and getattr(sys, "frozen", False):
        port = _find_free_port(5173)
        logger.info(f"Selected free port: {port}")

    # Open browser after a short delay
    def open_browser():
        import time
        time.sleep(1.5)
        try:
            url = f"http://{Config.HOST}:{port}" if port else f"http://{Config.HOST}:5173"
            webbrowser.open(url)
            logger.info(f"Browser opened to {url}")
        except Exception as e:
            logger.warning(f"Could not open browser: {e}")

    threading.Thread(target=open_browser, daemon=True).start()

    # Run app
    logger.info(f"Starting PyShell on {host}:{port if port else 'random'}")
    app.run(
        host=host,
        port=port,
        debug=False,
        use_reloader=False,
        # SSE terminal output holds a worker thread per open terminal,
        # so the dev server MUST handle requests concurrently or every
        # other request (input/resize/API) would hang after connecting.
        threaded=True,
    )


if __name__ == "__main__":
    main()