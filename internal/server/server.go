package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gymbro/internal/config"
	"gymbro/internal/database"
	"gymbro/internal/store"
)

const (
	readHeaderTimeout = 10 * time.Second
	shutdownTimeout   = 15 * time.Second
	// healthPath is probed by Kubernetes; unauthenticated, 503 when the database is unreachable.
	healthPath = "/health"
)

// Run wires the dependencies, serves HTTP and blocks until ctx is cancelled,
// then shuts the server down gracefully. The whole dependency graph lives here.
func Run(ctx context.Context, cfg config.Config) error {
	db, err := database.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect database: %w", err)
	}
	defer db.Close()

	validate, err := newValidator()
	if err != nil {
		return fmt.Errorf("create validator: %w", err)
	}
	st := store.New(db)
	h := &handlers{store: st, validate: validate, botUsername: cfg.BotUsername, cookieSecure: cfg.CookieSecure}

	router := newRouter(cfg.APISecret, st, h, func(c *gin.Context) {
		if db.Ping(c.Request.Context()) != nil {
			c.Status(http.StatusServiceUnavailable)
			return
		}
		c.Status(http.StatusOK)
	})
	srv := &http.Server{
		Addr:              net.JoinHostPort("", cfg.Port),
		Handler:           router,
		ReadHeaderTimeout: readHeaderTimeout,
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.ListenAndServe()
	}()
	log.Info().Str("addr", srv.Addr).Msg("server started")

	select {
	case err = <-serveErr:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	err = srv.Shutdown(shutdownCtx)
	if err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	err = <-serveErr
	if !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}

	log.Info().Msg("server stopped")
	return nil
}

func newRouter(secret string, sessions sessionReader, h *handlers, health gin.HandlerFunc) *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())
	registerDocs(router)
	router.Use(authenticate(secret, sessions))
	router.GET(healthPath, health)
	v1 := router.Group("/v1")
	h.register(v1.Group("", requireService()), v1.Group("", requireUserAccess()))
	authGroup := router.Group("/auth")
	h.registerAuth(authGroup, authGroup.Group("", requireSession()))
	return router
}
