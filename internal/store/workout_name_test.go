package store

import (
	"testing"

	"gymbro/internal/apiclient"
)

func TestWorkoutNamePostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	req := workoutCreateRequest()
	first, err := s.CreateWorkout(ctx, user, req)
	if err != nil {
		t.Fatal(err)
	}
	read := func() apiclient.Workout {
		t.Helper()
		page, err := s.ListWorkouts(ctx, user, 10, "")
		if err != nil || len(page.Workouts) != 1 {
			t.Fatalf("list: %+v %v", page, err)
		}
		return page.Workouts[0]
	}
	if w := read(); w.Name != "upper" || (w.Type == nil || *w.Type != "upper") {
		t.Fatalf("legacy default: %+v", w)
	}
	custom := "  My free Workout  "
	edit := apiclient.UpdateWorkoutRequest{PerformedOn: req.PerformedOn, Name: &custom, Type: "lower", RawText: req.RawText, Entries: req.Entries}
	if _, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit); err != nil {
		t.Fatal(err)
	}
	if w := read(); w.Name != "My free Workout" || w.Type == nil || *w.Type != "lower" {
		t.Fatalf("independent name: %+v", w)
	}
	edit.Name = nil
	if _, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit); err != nil {
		t.Fatal(err)
	}
	if w := read(); w.Name != "" || w.Source != req.Source || w.SourceRef != req.SourceRef {
		t.Fatalf("omitted name/identity: %+v", w)
	}
	empty := ""
	edit.Name = &empty
	cleared, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit)
	if err != nil {
		t.Fatal(err)
	}
	historical := read()
	if historical.Name != "" || !historical.UpdatedAt.Equal(cleared.UpdatedAt) {
		t.Fatalf("explicit empty: %+v", historical)
	}
	// Program rename/deletion must not modify matching historical workouts.
	p, _, err := s.CreateProgram(ctx, user, programRequest("cc000000-0000-4000-8000-000000000005", "upper"))
	if err != nil {
		t.Fatal(err)
	}
	p, err = s.UpdateProgram(ctx, user, p.ID, apiclient.UpdateProgramRequest{Name: "Renamed program", Entries: p.Entries, ExpectedUpdatedAt: p.UpdatedAt})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteProgram(ctx, user, p.ID, p.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	if w := read(); w.Name != historical.Name || !w.UpdatedAt.Equal(historical.UpdatedAt) {
		t.Fatalf("program changed history: %+v", w)
	}
}
