// shellserver serves only public assets on loopback for browser tests. API calls
// are mocked by Playwright; this is never a user-data or development API server.
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	root, err := filepath.Abs("internal/server/web")
	if err != nil {
		log.Fatal(err)
	}
	if _, err = os.Stat(root); err != nil {
		log.Fatal(err)
	}
	files := http.FileServer(http.Dir(root))
	log.Fatal(http.ListenAndServe("127.0.0.1:8092", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/sw.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		if r.URL.Path == "/manifest.webmanifest" {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		files.ServeHTTP(w, r)
	})))
}
