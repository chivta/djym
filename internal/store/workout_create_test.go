package store

import (
	"sync"
	"testing"
	"time"

	"gymbro/internal/apiclient"
)

func workoutCreateRequest() apiclient.SaveWorkoutRequest {
	kcal, protein := 2200, 130
	start := time.Date(2026, 10, 11, 10, 0, 0, 123456000, time.UTC)
	finish := start.Add(time.Hour)
	return apiclient.SaveWorkoutRequest{PerformedOn: "2026-10-11", Type: "UPPER", Kcal: &kcal, ProteinG: &protein, Note: "note", RawText: "same raw", Source: "mobile", SourceRef: "550e8400-e29b-41d4-a716-446655440000", StartedAt: &start, FinishedAt: &finish,
		Entries: []apiclient.Entry{{Name: "Written bench", Sets: []apiclient.Set{{Weight: "13.50", Reps: 8}}}, {Name: "Empty", Sets: []apiclient.Set{}}}}
}

func TestCreateWorkoutDuplicateSourcePostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	req := workoutCreateRequest()
	first, err := s.CreateWorkout(ctx, user, req)
	if err != nil || !first.Created || len(first.NewExercises) != 2 {
		t.Fatalf("first: %+v %v", first, err)
	}
	for _, changed := range []bool{false, true} {
		if changed {
			req.Note = "changed"
		}
		next, err := s.CreateWorkout(ctx, user, req)
		if err != nil || !next.Created || next.WorkoutID == first.WorkoutID || len(next.NewExercises) != 0 {
			t.Fatalf("duplicate: %+v %v", next, err)
		}
	}
	page, err := s.ListWorkouts(ctx, user, 1, "")
	if err != nil || len(page.Workouts) != 1 || page.NextCursor == nil {
		t.Fatalf("page: %+v %v", page, err)
	}
	second, err := s.ListWorkouts(ctx, user, 1, *page.NextCursor)
	if err != nil || len(second.Workouts) != 1 || second.Workouts[0].ID == page.Workouts[0].ID || second.NextCursor == nil {
		t.Fatalf("second: %+v %v", second, err)
	}
	third, err := s.ListWorkouts(ctx, user, 1, *second.NextCursor)
	if err != nil || len(third.Workouts) != 1 || third.Workouts[0].ID != first.WorkoutID || third.NextCursor != nil || third.Workouts[0].Note == nil || *third.Workouts[0].Note != "note" {
		t.Fatalf("original changed: %+v %v", third, err)
	}
}

func TestCreateWorkoutConcurrentPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	// Avoid testing unrelated concurrent catalog insertion here.
	if _, err := s.CreateWorkout(ctx, user, workoutCreateRequest()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan apiclient.SaveWorkoutResponse, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := s.CreateWorkout(ctx, user, workoutCreateRequest())
			results <- r
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	ids := map[int64]bool{}
	for r := range results {
		if !r.Created || ids[r.WorkoutID] {
			t.Fatalf("not distinct: %+v", r)
		}
		ids[r.WorkoutID] = true
	}
}
