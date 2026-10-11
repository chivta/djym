package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"gymbro/internal/apperr"
	"gymbro/internal/token"
)

const (
	deleteExpiredLogins   = `DELETE FROM login_requests WHERE expires_at <= now()`
	deleteExpiredSessions = `DELETE FROM sessions WHERE expires_at <= now()`
	insertLoginRequest    = `INSERT INTO login_requests (token_hash, nonce_hash, expires_at)
		VALUES ($1, $2, now() + $3::interval) RETURNING expires_at`

	confirmLoginRequest = `UPDATE login_requests SET user_id = $2, confirmed_at = now()
		WHERE token_hash = $1 AND confirmed_at IS NULL AND expires_at > now()
		RETURNING id`
	selectLoginExpired = `SELECT expires_at <= now() FROM login_requests
		WHERE token_hash = $1 AND confirmed_at IS NULL`

	consumeLoginRequest = `UPDATE login_requests SET consumed_at = now()
		WHERE nonce_hash = $1 AND confirmed_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
		RETURNING user_id`
	selectLoginPending = `SELECT EXISTS (SELECT 1 FROM login_requests
		WHERE nonce_hash = $1 AND confirmed_at IS NULL AND expires_at > now())`

	insertSession = `INSERT INTO sessions (token_hash, user_id, expires_at)
		VALUES ($1, $2, now() + $3::interval) RETURNING expires_at`
	selectSessionUser = `SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()`
	deleteSession     = `DELETE FROM sessions WHERE token_hash = $1`
)

// LoginRequest is a new sign-in request. Token goes to the identity provider
// (the bot deep link), Nonce stays with the requesting client; only their hashes are stored.
type LoginRequest struct {
	Token     string
	Nonce     string
	ExpiresAt time.Time
}

// Session is a new user session. Token is a cookie or native bearer value; only its hash is stored.
type Session struct {
	Token     string
	UserID    int64
	ExpiresAt time.Time
}

// CreateLoginRequest stores a new sign-in request valid for ttl. It also deletes
// expired login requests and sessions, which is the only cleanup they get.
func (s *Store) CreateLoginRequest(ctx context.Context, ttl time.Duration) (LoginRequest, error) {
	req := LoginRequest{Token: token.New(), Nonce: token.New()}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, deleteExpiredLogins)
		if err != nil {
			return fmt.Errorf("delete expired logins: %w", err)
		}
		_, err = tx.Exec(ctx, deleteExpiredSessions)
		if err != nil {
			return fmt.Errorf("delete expired sessions: %w", err)
		}
		err = tx.QueryRow(ctx, insertLoginRequest, token.Hash(req.Token), token.Hash(req.Nonce), ttl).Scan(&req.ExpiresAt)
		if err != nil {
			return fmt.Errorf("insert login request: %w", err)
		}
		return nil
	})
	if err != nil {
		return LoginRequest{}, err
	}
	return req, nil
}

// ConfirmLogin binds the login request with this token to userID. Fails with
// apperr.ErrLoginExpired if it timed out, apperr.ErrLoginInvalid if it does not
// exist or was already confirmed.
func (s *Store) ConfirmLogin(ctx context.Context, loginToken string, userID int64) error {
	hash := token.Hash(loginToken)
	var id int64
	err := s.pool.QueryRow(ctx, confirmLoginRequest, hash, userID).Scan(&id)
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return mapPgError(fmt.Errorf("confirm login: %w", err))
	}

	// Not updated: tell an expired request apart from an unknown or used one.
	var expired bool
	err = s.pool.QueryRow(ctx, selectLoginExpired, hash).Scan(&expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.ErrLoginInvalid
	}
	if err != nil {
		return fmt.Errorf("select login: %w", err)
	}
	if expired {
		return apperr.ErrLoginExpired
	}
	// Confirmed concurrently between the two statements.
	return apperr.ErrLoginInvalid
}

// ClaimLogin is the client's poll for the request bound to nonce. While it
// awaits confirmation it returns (nil, nil). Once confirmed it marks the request
// consumed and returns a new session valid for sessionTTL, in one transaction.
// An unknown, expired or already consumed request fails with apperr.ErrLoginExpired.
func (s *Store) ClaimLogin(ctx context.Context, nonce string, sessionTTL time.Duration) (*Session, error) {
	hash := token.Hash(nonce)
	var session *Session
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var userID int64
		err := tx.QueryRow(ctx, consumeLoginRequest, hash).Scan(&userID)
		if errors.Is(err, pgx.ErrNoRows) {
			var pending bool
			err = tx.QueryRow(ctx, selectLoginPending, hash).Scan(&pending)
			if err != nil {
				return fmt.Errorf("select pending login: %w", err)
			}
			if !pending {
				return apperr.ErrLoginExpired
			}
			return nil
		}
		if err != nil {
			return fmt.Errorf("consume login: %w", err)
		}

		created := Session{Token: token.New(), UserID: userID}
		err = tx.QueryRow(ctx, insertSession, token.Hash(created.Token), userID, sessionTTL).Scan(&created.ExpiresAt)
		if err != nil {
			return fmt.Errorf("insert session: %w", err)
		}
		session = &created
		return nil
	})
	if err != nil {
		return nil, err
	}
	return session, nil
}

// SessionUser returns the user of a live session. Fails with
// apperr.ErrUnauthorized when the session is unknown or expired.
func (s *Store) SessionUser(ctx context.Context, sessionToken string) (int64, error) {
	var userID int64
	err := s.pool.QueryRow(ctx, selectSessionUser, token.Hash(sessionToken)).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, apperr.ErrUnauthorized
	}
	if err != nil {
		return 0, fmt.Errorf("select session: %w", err)
	}
	return userID, nil
}

// DeleteSession ends a session. Deleting an unknown session is not an error.
func (s *Store) DeleteSession(ctx context.Context, sessionToken string) error {
	_, err := s.pool.Exec(ctx, deleteSession, token.Hash(sessionToken))
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}
