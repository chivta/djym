package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"mime"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"gymbro/internal/apperr"
)

const (
	bearerPrefix = "Bearer "
	principalKey = "principal"
	userIDParam  = "id"
)

// principal is who a request acts as. The zero value is anonymous.
type principal struct {
	// service: the request carries the shared bot secret and may act on any user.
	service bool
	// userID: the request carries a valid cookie or bearer session (0 = none).
	userID       int64
	sessionToken string
	bearer       bool
}

// Authorization is two steps: authenticate puts a principal in the context,
// then a per-group guard (requireService, requireSession, requireUserAccess)
// decides. The save handler additionally restricts user-created source identity.
//
// Cookie workout writes require a non-simple header and JSON content type;
// bearer sessions are non-ambient and need no CSRF header. Logout retains the
// existing SameSite=Lax cookie protection. No permissive CORS is enabled.

type sessionReader interface {
	SessionUser(context.Context, string) (int64, error)
}

// authenticate checks the bot secret first, then native sessions. A supplied
// invalid bearer never falls back to an ambient cookie.
func authenticate(secret string, sessions sessionReader) gin.HandlerFunc {
	// Compare fixed-size digests so the comparison does not leak the secret length.
	want := sha256.Sum256([]byte(secret))

	return func(c *gin.Context) {
		var p principal
		headers := c.Request.Header.Values("Authorization")
		if len(headers) != 0 {
			tok, ok := strings.CutPrefix(headers[0], bearerPrefix)
			got := sha256.Sum256([]byte(tok))
			if len(headers) != 1 || !ok || tok == "" {
				abortWithError(c, apperr.ErrUnauthorized)
				return
			}
			if subtle.ConstantTimeCompare(got[:], want[:]) == 1 {
				p.service = true
			} else {
				if strings.ContainsAny(tok, " \t\r\n") {
					abortWithError(c, apperr.ErrUnauthorized)
					return
				}
				userID, err := sessions.SessionUser(c.Request.Context(), tok)
				if err != nil {
					abortWithError(c, err)
					return
				}
				p.userID, p.sessionToken, p.bearer = userID, tok, true
			}
		} else {
			cookie, err := c.Cookie(sessionCookie)
			if err == nil && cookie != "" {
				userID, err := sessions.SessionUser(c.Request.Context(), cookie)
				if err != nil && !errors.Is(err, apperr.ErrUnauthorized) {
					abortWithError(c, err)
					return
				}
				p.userID = userID
				if userID != 0 {
					p.sessionToken = cookie
				}
			}
		}
		c.Set(principalKey, p)
		c.Next()
	}
}

func currentPrincipal(c *gin.Context) principal {
	p, _ := c.Get(principalKey)
	pr, _ := p.(principal)
	return pr
}

// guard turns an authorization decision into middleware.
func guard(decide func(c *gin.Context) error) gin.HandlerFunc {
	return func(c *gin.Context) {
		err := decide(c)
		if err != nil {
			abortWithError(c, err)
			return
		}
		c.Next()
	}
}

// requireService admits only the bot.
func requireService() gin.HandlerFunc {
	return guard(func(c *gin.Context) error {
		p := currentPrincipal(c)
		switch {
		case p.service:
			return nil
		case p.userID != 0:
			return apperr.ErrForbidden
		default:
			return apperr.ErrUnauthorized
		}
	})
}

// requireSession admits only a valid user cookie or native bearer session.
func requireSession() gin.HandlerFunc {
	return guard(func(c *gin.Context) error {
		if currentPrincipal(c).userID == 0 {
			return apperr.ErrUnauthorized
		}
		return nil
	})
}

// requireUserAccess admits the service for any :id and a session only for its own :id.
func requireUserAccess() gin.HandlerFunc {
	return guard(func(c *gin.Context) error {
		return authorizeUser(currentPrincipal(c), c.Param(userIDParam))
	})
}

// authorizeUser is the decision of requireUserAccess. A malformed id from the
// service passes through so the handler answers 400.
func authorizeUser(p principal, pathID string) error {
	switch {
	case p.service:
		return nil
	case p.userID == 0:
		return apperr.ErrUnauthorized
	case pathID != strconv.FormatInt(p.userID, 10):
		return apperr.ErrForbidden
	default:
		return nil
	}
}

func abortWithError(c *gin.Context, err error) {
	respondWithError(c, err)
	c.Abort()
}

// requireWorkoutWrite prevents ambient cookie writes from cross-site forms.
func requireWorkoutWrite() gin.HandlerFunc {
	return guard(func(c *gin.Context) error {
		p := currentPrincipal(c)
		if p.service || p.bearer {
			return nil
		}
		mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
		if err != nil || mediaType != "application/json" || c.GetHeader("X-Gymbro-Write") != "1" {
			return apperr.ErrForbidden
		}
		return nil
	})
}
