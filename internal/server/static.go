package server

import (
	"embed"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Explicit embedding keeps test/tooling files out of the shipped binary.
//
//go:embed web/index.html web/style.css web/app.js web/domain.js web/db.js web/api.js web/sync.js web/sw.js web/manifest.webmanifest web/icon.svg web/icon-192.png web/icon-512.png
var publicWeb embed.FS

var webRoutes = map[string]string{
	"/": "index.html", "/index.html": "index.html", "/style.css": "style.css",
	"/app.js": "app.js", "/domain.js": "domain.js", "/db.js": "db.js", "/api.js": "api.js", "/sync.js": "sync.js",
	"/sw.js": "sw.js", "/manifest.webmanifest": "manifest.webmanifest", "/icon.svg": "icon.svg",
	"/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png",
}

func registerWeb(router *gin.Engine) {
	for route, file := range webRoutes {
		content, err := publicWeb.ReadFile("web/" + file)
		if err != nil {
			panic(err)
		}
		mime := "text/javascript; charset=utf-8"
		switch file {
		case "index.html":
			mime = "text/html; charset=utf-8"
		case "style.css":
			mime = "text/css; charset=utf-8"
		case "manifest.webmanifest":
			mime = "application/manifest+json"
		case "icon.svg":
			mime = "image/svg+xml"
		case "icon-192.png", "icon-512.png":
			mime = "image/png"
		}
		handler := func(c *gin.Context) {
			c.Header("Cache-Control", "no-cache")
			c.Header("X-Content-Type-Options", "nosniff")
			c.Header("Referrer-Policy", "no-referrer")
			c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
			if file == "sw.js" {
				c.Header("Service-Worker-Allowed", "/")
			}
			c.Data(http.StatusOK, mime, content)
		}
		router.GET(route, handler)
		router.HEAD(route, handler)
	}
}
