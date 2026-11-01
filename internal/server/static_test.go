package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type unavailableSessions struct{}

func (unavailableSessions) SessionUser(context.Context, string) (int64, error) {
	return 0, errors.New("database unavailable")
}

func TestPublicWebBeforeAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := newRouter("test", unavailableSessions{}, &handlers{}, func(c *gin.Context) { c.Status(200) })
	for _, asset := range []struct{ path, mime string }{{"/", "text/html"}, {"/app.js", "text/javascript"}, {"/sw.js", "text/javascript"}, {"/manifest.webmanifest", "application/manifest+json"}, {"/icon-192.png", "image/png"}, {"/icon-512.png", "image/png"}} {
		t.Run(asset.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, asset.path, nil)
			request.Header.Set("Cookie", "gymbro_session=expired")
			request.Header.Set("Authorization", "invalid")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != 200 || !strings.HasPrefix(response.Header().Get("Content-Type"), asset.mime) {
				t.Fatalf("%d %v", response.Code, response.Header())
			}
			if asset.path == "/sw.js" && response.Header().Get("Service-Worker-Allowed") != "/" {
				t.Fatal("missing root scope")
			}
			if response.Header().Get("Set-Cookie") != "" {
				t.Fatal("public shell must not set cookies")
			}
		})
	}
	for _, path := range []string{"/v1/missing", "/auth/missing", "/docs/missing", "/missing", "/static_test.go", "/package.json", "/domain.test.js"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code == 200 || strings.Contains(response.Body.String(), "<!doctype html>") {
			t.Fatalf("%s returned shell: %d", path, response.Code)
		}
	}
}
