package server

import (
	"testing"
	"time"

	"gymbro/internal/apiclient"
)

func TestSaveWorkoutValidation(t *testing.T) {
	v, err := newValidator()
	if err != nil {
		t.Fatal(err)
	}
	neg := -1
	t0 := time.Date(2026, 10, 3, 18, 0, 0, 0, time.UTC)
	before, after := t0.Add(-time.Minute), t0.Add(time.Hour)

	valid := func() apiclient.SaveWorkoutRequest {
		return apiclient.SaveWorkoutRequest{
			PerformedOn: "2026-10-03", Type: "Upper", RawText: "x", Source: "s", SourceRef: "1",
			Entries: []apiclient.Entry{{Name: "жим", Sets: []apiclient.Set{{Weight: "60.5", Reps: 10}}}},
		}
	}
	tests := []struct {
		name   string
		mutate func(*apiclient.SaveWorkoutRequest)
		ok     bool
	}{
		{"valid", func(*apiclient.SaveWorkoutRequest) {}, true},
		{"no entries sets", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets = nil }, true},
		{"bad type", func(r *apiclient.SaveWorkoutRequest) { r.Type = "cardio" }, false},
		{"bad date", func(r *apiclient.SaveWorkoutRequest) { r.PerformedOn = "03.10.2026" }, false},
		{"negative kcal", func(r *apiclient.SaveWorkoutRequest) { r.Kcal = &neg }, false},
		{"three decimals", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets[0].Weight = "60.125" }, false},
		{"negative weight", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets[0].Weight = "-5" }, false},
		{"zero reps", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Sets[0].Reps = 0 }, false},
		{"empty name", func(r *apiclient.SaveWorkoutRequest) { r.Entries[0].Name = "" }, false},
		{"no source ref", func(r *apiclient.SaveWorkoutRequest) { r.SourceRef = "" }, false},
		{"times ok", func(r *apiclient.SaveWorkoutRequest) { r.StartedAt, r.FinishedAt = &t0, &after }, true},
		{"times equal", func(r *apiclient.SaveWorkoutRequest) { r.StartedAt, r.FinishedAt = &t0, &t0 }, true},
		{"only started", func(r *apiclient.SaveWorkoutRequest) { r.StartedAt = &t0 }, false},
		{"only finished", func(r *apiclient.SaveWorkoutRequest) { r.FinishedAt = &t0 }, false},
		{"finished before started", func(r *apiclient.SaveWorkoutRequest) { r.StartedAt, r.FinishedAt = &t0, &before }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := valid()
			tt.mutate(&req)
			err := v.Struct(req)
			if (err == nil) != tt.ok {
				t.Fatalf("ok=%v, err=%v", tt.ok, err)
			}
		})
	}
}

func TestUpdateWorkoutValidation(t *testing.T) {
	v, err := newValidator()
	if err != nil {
		t.Fatal(err)
	}
	neg := -1
	started := revision
	finished := started.Add(time.Hour)
	tests := []struct {
		name   string
		mutate func(*apiclient.UpdateWorkoutRequest)
		ok     bool
	}{
		{"empty historical entries", func(r *apiclient.UpdateWorkoutRequest) { r.Entries = nil }, true},
		{"empty historical sets", func(r *apiclient.UpdateWorkoutRequest) { r.Entries[0].Sets = nil }, true},
		{"maximum decimal", func(r *apiclient.UpdateWorkoutRequest) { r.Entries[0].Sets[0].Weight = "9999.99" }, true},
		{"too much weight", func(r *apiclient.UpdateWorkoutRequest) { r.Entries[0].Sets[0].Weight = "10000" }, false},
		{"three decimals", func(r *apiclient.UpdateWorkoutRequest) { r.Entries[0].Sets[0].Weight = "1.001" }, false},
		{"zero reps", func(r *apiclient.UpdateWorkoutRequest) { r.Entries[0].Sets[0].Reps = 0 }, false},
		{"unknown type", func(r *apiclient.UpdateWorkoutRequest) { r.Type = "cardio" }, false},
		{"negative intake", func(r *apiclient.UpdateWorkoutRequest) { r.ProteinG = &neg }, false},
		{"blank exercise", func(r *apiclient.UpdateWorkoutRequest) { r.Entries[0].Name = "" }, false},
		{"missing revision", func(r *apiclient.UpdateWorkoutRequest) { r.ExpectedUpdatedAt = time.Time{} }, false},
		{"times together", func(r *apiclient.UpdateWorkoutRequest) { r.StartedAt, r.FinishedAt = &started, &finished }, true},
		{"only started", func(r *apiclient.UpdateWorkoutRequest) { r.StartedAt = &started }, false},
		{"finished before started", func(r *apiclient.UpdateWorkoutRequest) { r.StartedAt, r.FinishedAt = &finished, &started }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := apiclient.UpdateWorkoutRequest{PerformedOn: "2026-10-03", RawText: "x", ExpectedUpdatedAt: revision,
				Entries: []apiclient.Entry{{Name: "Squat", Sets: []apiclient.Set{{Weight: "0", Reps: 1}}}}}
			tt.mutate(&req)
			err := v.Struct(req)
			if (err == nil) != tt.ok {
				t.Fatalf("ok=%v err=%v", tt.ok, err)
			}
		})
	}
}
