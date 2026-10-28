package server

import (
	"embed"
	"net/http"

	"github.com/gin-gonic/gin"
)

//go:embed docs/index.html docs/openapi.json
var documentation embed.FS

// registerDocs runs before authenticate is installed: even stale credentials
// must not prevent reading documentation. API routes still use authentication.
func registerDocs(router *gin.Engine) {
	router.GET("/swagger", func(c *gin.Context) {
		c.Redirect(http.StatusMovedPermanently, "/swagger/index.html")
	})
	router.GET("/swagger/", func(c *gin.Context) {
		c.Redirect(http.StatusMovedPermanently, "/swagger/index.html")
	})
	for path, file := range map[string]string{
		"/swagger/index.html":   "docs/index.html",
		"/swagger/openapi.json": "docs/openapi.json",
	} {
		content, err := documentation.ReadFile(file)
		if err != nil {
			panic(err) // Embedded files are checked at build time.
		}
		contentType := "text/html; charset=utf-8"
		if path == "/swagger/openapi.json" {
			contentType = "application/json; charset=utf-8"
		}
		router.GET(path, func(c *gin.Context) {
			c.Header("X-Content-Type-Options", "nosniff")
			c.Data(http.StatusOK, contentType, content)
		})
	}
}
