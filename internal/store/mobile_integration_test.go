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

func TestMobileWorkoutPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	userID := newTestUser(t, ctx, pool)
	otherID := newTestUser(t, ctx, pool)
	req := apiclient.SaveWorkoutRequest{PerformedOn: "2026-10-03", Type: "upper", Note: "original", RawText: "raw original", Source: "telegram", SourceRef: "historical",
		Entries: []apiclient.Entry{{Name: "Squat", Sets: []apiclient.Set{{Weight: "13.50", Reps: 10}}}, {Name: "Empty", Sets: []apiclient.Set{}}}}
	first, err := s.SaveWorkout(ctx, userID, req)
	if err != nil || !first.Created || first.UpdatedAt.IsZero() || len(first.NewExercises) != 2 {
		t.Fatalf("create: %+v %v", first, err)
	}
	retry, err := s.SaveWorkout(ctx, userID, req)
	if err != nil || retry.Created || retry.WorkoutID != first.WorkoutID || !retry.UpdatedAt.After(first.UpdatedAt) || len(retry.NewExercises) != 0 {
		t.Fatalf("upsert: %+v %v", retry, err)
	}
	page, err := s.ListWorkouts(ctx, userID, 1, "")
	if err != nil || len(page.Workouts) != 1 {
		t.Fatalf("list: %+v %v", page, err)
	}
	w := page.Workouts[0]
	if w.SourceRef != req.SourceRef || w.RawText != req.RawText || !w.UpdatedAt.Equal(retry.UpdatedAt) || w.UpdatedAt.Location() != time.UTC || len(w.Entries) != 2 || len(w.Entries[1].Sets) != 0 || w.Entries[0].Sets[0].Weight != "13.5" || w.Type == nil || *w.Type != "upper" {
		t.Fatalf("list lost metadata/sets: %+v", w)
	}
	edit := apiclient.UpdateWorkoutRequest{PerformedOn: "2026-10-02", RawText: "edited", Entries: []apiclient.Entry{{Name: "Squat", Sets: []apiclient.Set{}}}, ExpectedUpdatedAt: retry.UpdatedAt}
	_, err = s.UpdateWorkout(ctx, otherID, first.WorkoutID, edit)
	if !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("other user's edit: %v", err)
	}
	err = s.DeleteWorkout(ctx, otherID, first.WorkoutID, retry.UpdatedAt)
	if !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("other user's delete: %v", err)
	}
	edit.ExpectedUpdatedAt = first.UpdatedAt
	_, err = s.UpdateWorkout(ctx, userID, first.WorkoutID, edit)
	if !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("stale edit: %v", err)
	}
	edit.ExpectedUpdatedAt = retry.UpdatedAt
	// Two contenders with one revision must yield exactly one write and one 409.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.UpdateWorkout(ctx, userID, first.WorkoutID, edit); results <- err }()
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, apperr.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("race: successes=%d conflicts=%d", successes, conflicts)
	}
	page, err = s.ListWorkouts(ctx, userID, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	w = page.Workouts[0]
	if w.ID != first.WorkoutID || w.Source != "telegram" || w.SourceRef != "historical" || w.RawText != "edited" || !w.UpdatedAt.After(retry.UpdatedAt) || len(w.Entries) != 1 || len(w.Entries[0].Sets) != 0 {
		t.Fatalf("edit lost identity: %+v", w)
	}
	// A failure after row update must roll back its revision and entry replacement.
	invalid := edit
	invalid.ExpectedUpdatedAt = w.UpdatedAt
	invalid.Entries = []apiclient.Entry{{Name: "Squat", Sets: []apiclient.Set{{Weight: "bad", Reps: 1}}}}
	_, err = s.UpdateWorkout(ctx, userID, w.ID, invalid)
	if err == nil {
		t.Fatal("invalid set unexpectedly accepted")
	}
	page, err = s.ListWorkouts(ctx, userID, 10, "")
	if err != nil || !page.Workouts[0].UpdatedAt.Equal(w.UpdatedAt) || len(page.Workouts[0].Entries[0].Sets) != 0 {
		t.Fatalf("failed edit not rolled back: %+v %v", page, err)
	}
	err = s.DeleteWorkout(ctx, userID, w.ID, retry.UpdatedAt)
	if !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("stale delete: %v", err)
	}
	err = s.DeleteWorkout(ctx, userID, w.ID, w.UpdatedAt)
	if err != nil {
		t.Fatal(err)
	}
	err = s.DeleteWorkout(ctx, userID, w.ID, w.UpdatedAt)
	if !errors.Is(err, apperr.ErrWorkoutNotFound) {
		t.Fatalf("deleted not found: %v", err)
	}
	var count int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM workout_exercises WHERE workout_id = $1`, w.ID).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("entries not cascaded: %d %v", count, err)
	}
	// Stable mobile UUID retries and paginated extended DTOs.
	req.Source, req.SourceRef = "mobile", "550e8400-e29b-41d4-a716-446655440000"
	mobile, err := s.SaveWorkout(ctx, userID, req)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.SaveWorkout(ctx, userID, req)
	if err != nil || again.WorkoutID != mobile.WorkoutID || again.Created {
		t.Fatalf("mobile retry: %+v %v", again, err)
	}
	req.SourceRef = "550e8400-e29b-41d4-a716-446655440001"
	_, err = s.SaveWorkout(ctx, userID, req)
	if err != nil {
		t.Fatal(err)
	}
	page, err = s.ListWorkouts(ctx, userID, 1, "")
	if err != nil || page.NextCursor == nil {
		t.Fatalf("first page: %+v %v", page, err)
	}
	next, err := s.ListWorkouts(ctx, userID, 1, *page.NextCursor)
	if err != nil || len(next.Workouts) != 1 || next.Workouts[0].ID != mobile.WorkoutID || next.NextCursor != nil {
		t.Fatalf("next page: %+v %v", next, err)
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
