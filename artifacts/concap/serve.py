"""Serve Concap's original website without transforming its HTML, CSS or JS."""
from pathlib import Path
import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn


FRONTEND = Path(__file__).resolve().parent / "frontend"
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


PAGES = {
    "/": "landing.html",
    **{
        "/" + name: name + ".html"
        for name in (
            "login", "signup", "change-password", "members", "admin",
            "dashboard", "booth", "long-capture", "transcribe", "scan",
            "contacts", "conversations", "companies", "integrations",
            "meetings", "imported-meetings", "all-meetings", "quotes",
            "branding", "brands", "profile", "privacy",
        )
    },
}


def page_handler(filename: str):
    def page():
        return FileResponse(FRONTEND / filename)
    return page


for route, filename in PAGES.items():
    app.add_api_route(route, page_handler(filename), methods=["GET"])


@app.get("/favicon.ico")
@app.get("/favicon.svg")
def favicon():
    return FileResponse(FRONTEND / "favicon.svg", media_type="image/svg+xml")


@app.get("/sw.js")
def service_worker():
    return FileResponse(
        FRONTEND / "sw.js", media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(
        FRONTEND / "manifest.webmanifest",
        media_type="application/manifest+json",
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ["PORT"]))
