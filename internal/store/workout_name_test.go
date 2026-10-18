package store

import (
	"errors"
	"testing"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

func TestWorkoutNamePostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	req := createReplayRequest()
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
	if w := read(); w.Name != "upper" || optionalValue(w.Type) != "upper" {
		t.Fatalf("legacy default: %+v", w)
	}
	custom := "  My free Workout  "
	req.Name = &custom
	if _, err := s.CreateWorkout(ctx, user, req); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("name replay mismatch: %v", err)
	}
	service, err := s.SaveWorkout(ctx, user, req)
	if err != nil || service.Created {
		t.Fatalf("service: %+v %v", service, err)
	}
	if w := read(); w.Name != "My free Workout" || optionalValue(w.Type) != "upper" {
		t.Fatalf("independent name: %+v", w)
	}
	if replay, err := s.CreateWorkout(ctx, user, req); err != nil || !replay.UpdatedAt.Equal(service.UpdatedAt) {
		t.Fatalf("named replay: %+v %v", replay, err)
	}
	edit := apiclient.UpdateWorkoutRequest{PerformedOn: req.PerformedOn, Type: "lower", RawText: req.RawText, Entries: req.Entries, ExpectedUpdatedAt: service.UpdatedAt}
	updated, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit)
	if err != nil {
		t.Fatal(err)
	}
	w := read()
	if w.Name != "My free Workout" || optionalValue(w.Type) != "lower" || w.Source != req.Source || w.SourceRef != req.SourceRef {
		t.Fatalf("omitted name/identity: %+v", w)
	}
	empty := ""
	edit.Name = &empty
	edit.ExpectedUpdatedAt = updated.UpdatedAt
	cleared, err := s.UpdateWorkout(ctx, user, first.WorkoutID, edit)
	if err != nil {
		t.Fatal(err)
	}
	if w := read(); w.Name != "" || !w.UpdatedAt.Equal(cleared.UpdatedAt) {
		t.Fatalf("explicit empty: %+v", w)
	}
	// Service upserts with omitted names keep their replacement semantics.
	req.Name = nil
	if _, err := s.SaveWorkout(ctx, user, req); err != nil {
		t.Fatal(err)
	}
	historical := read()
	if historical.Name != "upper" {
		t.Fatalf("service omitted name derives type: %+v", historical)
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
