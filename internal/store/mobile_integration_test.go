package store

import (
	"context"
	"errors"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
	"gymbro/internal/database"
	"gymbro/internal/token"
)

// These tests are opt-in and reject non-local or non-test databases. The caller
// provisions an isolated database; they never read the project's .env.
func localMobileStore(t *testing.T) (*Store, *pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("GYMBRO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GYMBRO_TEST_DATABASE_URL to an isolated localhost gymbro_mobile_test database")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Path != "/gymbro_mobile_test" {
		t.Fatal("only an isolated localhost gymbro_mobile_test database is allowed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	pool, err := database.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return New(pool), pool, ctx
}

func newTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, insertUser).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Delete workouts first: the exercise FK is RESTRICT, even during a
		// user cascade, so independent cascade ordering must not affect cleanup.
		_, err := pool.Exec(ctx, `DELETE FROM workouts WHERE user_id = $1`, id)
		if err != nil {
			t.Error(err)
		}
		_, err = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
		if err != nil {
			t.Error(err)
		}
	})
	return id
}

func TestWorkoutReplacementPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user, other := newTestUser(t, ctx, pool), newTestUser(t, ctx, pool)
	req := workoutCreateRequest()
	name := "Custom"
	req.Name = &name
	first, err := s.CreateWorkout(ctx, user, req)
	if err != nil {
		t.Fatal(err)
	}
	edit := apiclient.UpdateWorkoutRequest{PerformedOn: "2026-10-02", RawText: "edited", Entries: []apiclient.Entry{{Name: "Written bench"}}}
	if _, err := s.UpdateWorkout(ctx, other, first.WorkoutID, edit); !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("ownership: %v", err)
	}
	if err := s.DeleteWorkout(ctx, other, first.WorkoutID); !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("ownership: %v", err)
	}
	// Both writers succeed without fetching or supplying revision metadata.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit); results <- err }()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListWorkouts(ctx, user, 10, "")
	if err != nil || len(page.Workouts) != 1 {
		t.Fatalf("list: %+v %v", page, err)
	}
	w := page.Workouts[0]
	if w.ID != first.WorkoutID || w.Source != req.Source || w.SourceRef != req.SourceRef || w.Name != "" || w.Type != nil || w.Kcal != nil || w.ProteinG != nil || w.Note != nil || w.StartedAt != nil || w.FinishedAt != nil || w.RawText != "edited" || len(w.Entries) != 1 || len(w.Entries[0].Sets) != 0 || !w.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("full replacement: %+v", w)
	}
	invalid := edit
	invalid.Entries = []apiclient.Entry{{Name: "Written bench", Sets: []apiclient.Set{{Weight: "bad", Reps: 1}}}}
	if _, err := s.UpdateWorkout(ctx, user, w.ID, invalid); err == nil {
		t.Fatal("invalid set accepted")
	}
	page, err = s.ListWorkouts(ctx, user, 10, "")
	if err != nil || !page.Workouts[0].UpdatedAt.Equal(w.UpdatedAt) || len(page.Workouts[0].Entries[0].Sets) != 0 {
		t.Fatalf("rollback: %+v %v", page, err)
	}
	// Delete after the newer writes also needs no revision.
	if err := s.DeleteWorkout(ctx, user, w.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteWorkout(ctx, user, w.ID); !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("deleted: %v", err)
	}
	if _, err := s.UpdateWorkout(ctx, user, w.ID, edit); !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("deleted update: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workout_exercises WHERE workout_id=$1`, w.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("cascade: %d %v", count, err)
	}
}

func TestMobileSessionPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	userID := newTestUser(t, ctx, pool)
	login, err := s.CreateLoginRequest(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.ClaimLogin(ctx, login.Nonce, time.Hour)
	if err != nil || session != nil {
		t.Fatalf("pending: %+v %v", session, err)
	}
	err = s.ConfirmLogin(ctx, login.Token, userID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	sessions := make(chan *Session, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			session, err := s.ClaimLogin(ctx, login.Nonce, time.Hour)
			sessions <- session
			errs <- err
		}()
	}
	wg.Wait()
	close(sessions)
	close(errs)
	for claimed := range sessions {
		if claimed != nil {
			if session != nil {
				t.Fatal("nonce claimed twice")
			}
			session = claimed
		}
	}
	expired := 0
	for err := range errs {
		if errors.Is(err, apperr.ErrLoginExpired) {
			expired++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if session == nil || expired != 1 {
		t.Fatal("claim must create exactly one session")
	}
	id, err := s.SessionUser(ctx, session.Token)
	if err != nil || id != userID {
		t.Fatalf("native session: %d %v", id, err)
	}
	err = s.DeleteSession(ctx, session.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.SessionUser(ctx, session.Token)
	if !errors.Is(err, apperr.ErrUnauthorized) {
		t.Fatalf("revoked session: %v", err)
	}
	tok := token.New()
	_, err = pool.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`, token.Hash(tok), userID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.SessionUser(ctx, tok)
	if !errors.Is(err, apperr.ErrUnauthorized) {
		t.Fatalf("expired session: %v", err)
	}
}
