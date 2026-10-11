package store

import (
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

func createReplayRequest() apiclient.SaveWorkoutRequest {
	kcal, protein := 2200, 130
	start := time.Date(2026, 10, 11, 10, 0, 0, 123456789, time.UTC)
	finish := start.Add(time.Hour)
	return apiclient.SaveWorkoutRequest{PerformedOn: "2026-10-11", Type: "UPPER", Kcal: &kcal, ProteinG: &protein, Note: "note", RawText: "same raw", Source: "mobile", SourceRef: "550e8400-e29b-41d4-a716-446655440000", StartedAt: &start, FinishedAt: &finish,
		Entries: []apiclient.Entry{{Name: "Written bench", Sets: []apiclient.Set{{Weight: "013.50", Reps: 8}, {Weight: "0.00", Reps: 1}}}, {Name: "Empty", Sets: []apiclient.Set{}}}}
}

func TestCreateWorkoutReplayPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	req := createReplayRequest()
	first, err := s.CreateWorkout(ctx, user, req)
	if err != nil || !first.Created {
		t.Fatalf("create: %+v %v", first, err)
	}
	var entryIDs, setIDs []int64
	err = pool.QueryRow(ctx, `SELECT array_agg(id ORDER BY position) FROM workout_exercises WHERE workout_id=$1`, first.WorkoutID).Scan(&entryIDs)
	if err != nil {
		t.Fatal(err)
	}
	err = pool.QueryRow(ctx, `SELECT array_agg(s.id ORDER BY e.position,s.position) FROM exercise_sets s JOIN workout_exercises e ON e.id=s.workout_exercise_id WHERE e.workout_id=$1`, first.WorkoutID).Scan(&setIDs)
	if err != nil {
		t.Fatal(err)
	}
	identical := createReplayRequest()
	identical.Type = "upper"
	identical.Entries[0].Sets[0].Weight = "13.5"
	replay, err := s.CreateWorkout(ctx, user, identical)
	if err != nil || replay.Created || replay.WorkoutID != first.WorkoutID || !replay.UpdatedAt.Equal(first.UpdatedAt) || len(replay.NewExercises) != 0 {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	var afterEntries, afterSets []int64
	err = pool.QueryRow(ctx, `SELECT array_agg(id ORDER BY position) FROM workout_exercises WHERE workout_id=$1`, first.WorkoutID).Scan(&afterEntries)
	if err != nil {
		t.Fatal(err)
	}
	err = pool.QueryRow(ctx, `SELECT array_agg(s.id ORDER BY e.position,s.position) FROM exercise_sets s JOIN workout_exercises e ON e.id=s.workout_exercise_id WHERE e.workout_id=$1`, first.WorkoutID).Scan(&afterSets)
	if err != nil || !reflect.DeepEqual(entryIDs, afterEntries) || !reflect.DeepEqual(setIDs, afterSets) {
		t.Fatalf("replay replaced entries/sets: %v %v %v", afterEntries, afterSets, err)
	}
	cases := []struct {
		name   string
		change func(*apiclient.SaveWorkoutRequest)
	}{
		{"date", func(r *apiclient.SaveWorkoutRequest) { r.PerformedOn = "2026-10-10" }},
		{"type", func(r *apiclient.SaveWorkoutRequest) { r.Type = "lower" }},
		{"kcal absent", func(r *apiclient.SaveWorkoutRequest) { r.Kcal = nil }},
		{"kcal", func(r *apiclient.SaveWorkoutRequest) { *r.Kcal = 0 }},
		{"protein", func(r *apiclient.SaveWorkoutRequest) { *r.ProteinG = 0 }},
		{"protein absent", func(r *apiclient.SaveWorkoutRequest) { r.ProteinG = nil }},
		{"note", func(r *apiclient.SaveWorkoutRequest) { r.Note = "changed" }},
		{"raw text", func(r *apiclient.SaveWorkoutRequest) { r.RawText = "changed" }},
		{"timestamps absent", func(r *apiclient.SaveWorkoutRequest) { r.StartedAt = nil; r.FinishedAt = nil }},
		{"started", func(r *apiclient.SaveWorkoutRequest) { v := r.StartedAt.Add(time.Minute); r.StartedAt = &v }},
		{"finished", func(r *apiclient.SaveWorkoutRequest) { v := r.FinishedAt.Add(time.Minute); r.FinishedAt = &v }},
		{"written name", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Name = "Do not create this exercise" }},
		{"entry order", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0], r.Entries[1] = r.Entries[1], r.Entries[0] }},
		{"weight", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets[0].Weight = "14" }},
		{"reps", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets[0].Reps = 9 }},
		{"set order", func(r *apiclient.SaveWorkoutRequest) {
			r.Entries[0].Sets[0], r.Entries[0].Sets[1] = r.Entries[0].Sets[1], r.Entries[0].Sets[0]
		}},
		{"entries absent", func(r *apiclient.SaveWorkoutRequest) { r.Entries = nil }},
		{"sets absent", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets = nil }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			different := createReplayRequest()
			tt.change(&different)
			_, err := s.CreateWorkout(ctx, user, different)
			if !errors.Is(err, apperr.ErrConflict) {
				t.Fatalf("differing replay: %v", err)
			}
		})
	}
	page, err := s.ListWorkouts(ctx, user, 10, "")
	if err != nil || len(page.Workouts) != 1 || !sameWorkoutContent(page.Workouts[0], req) || !page.Workouts[0].UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("replays changed content: %+v %v", page, err)
	}
	var catalog int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM exercises WHERE user_id=$1`, user).Scan(&catalog)
	if err != nil || catalog != 2 {
		t.Fatalf("replay changed catalog: %d %v", catalog, err)
	}
	// Device A lost the first response; B edits under its revision; A's retry conflicts.
	edit := apiclient.UpdateWorkoutRequest{PerformedOn: req.PerformedOn, Note: "device B", RawText: req.RawText, Entries: req.Entries, ExpectedUpdatedAt: first.UpdatedAt}
	updated, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateWorkout(ctx, user, req)
	if !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("lost-response replay: %v", err)
	}
	page, err = s.ListWorkouts(ctx, user, 10, "")
	if err != nil || page.Workouts[0].Note == nil || *page.Workouts[0].Note != "device B" || !page.Workouts[0].UpdatedAt.Equal(updated.UpdatedAt) {
		t.Fatalf("device B overwritten: %+v %v", page, err)
	}
	// Service/bot upsert still replaces even a mobile-source row.
	service, err := s.SaveWorkout(ctx, user, req)
	if err != nil || service.Created || !service.UpdatedAt.After(updated.UpdatedAt) {
		t.Fatalf("service upsert: %+v %v", service, err)
	}
}

func TestCreateWorkoutConcurrentPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	for _, different := range []bool{false, true} {
		t.Run(map[bool]string{false: "identical", true: "different"}[different], func(t *testing.T) {
			user := newTestUser(t, ctx, pool)
			start := make(chan struct{})
			var wg sync.WaitGroup
			responses := make(chan apiclient.SaveWorkoutResponse, 2)
			errs := make(chan error, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					req := createReplayRequest()
					if different && i == 1 {
						req.Note = "contender"
					}
					<-start
					r, e := s.CreateWorkout(ctx, user, req)
					responses <- r
					errs <- e
				}(i)
			}
			close(start)
			wg.Wait()
			close(responses)
			close(errs)
			conflicts, created := 0, 0
			var revision time.Time
			for err := range errs {
				if errors.Is(err, apperr.ErrConflict) {
					conflicts++
				} else if err != nil {
					t.Fatal(err)
				}
			}
			for r := range responses {
				if r.Created {
					created++
				}
				if r.WorkoutID != 0 {
					if !revision.IsZero() && !revision.Equal(r.UpdatedAt) {
						t.Fatal("identical concurrent replay changed revision")
					}
					revision = r.UpdatedAt
				}
			}
			want := 0
			if different {
				want = 1
			}
			if created != 1 || conflicts != want {
				t.Fatalf("created=%d conflicts=%d", created, conflicts)
			}
			page, err := s.ListWorkouts(ctx, user, 10, "")
			if err != nil || len(page.Workouts) != 1 {
				t.Fatalf("duplicate creates: %+v %v", page, err)
			}
		})
	}
}
