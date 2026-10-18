package server

import (
	"strings"
	"testing"

	"gymbro/internal/apiclient"
)

func TestWorkoutNameHTTP(t *testing.T) {
	for _, method := range []string{"POST", "PUT"} {
		for _, tc := range []struct {
			name   string
			value  *string
			want   string
			status int
		}{
			{name: "omitted", status: 200},
			{name: "explicit empty", value: stringPointer(""), status: 200},
			{name: "custom", value: stringPointer("  My Custom Name  "), want: "My Custom Name", status: 200},
			{name: "max Unicode", value: stringPointer(strings.Repeat("я", 2000)), want: strings.Repeat("я", 2000), status: 200},
			{name: "too long", value: stringPointer(strings.Repeat("я", 2001)), status: 400},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				f := &mobileStoreFake{}
				r := mobileRouter(t, f)
				path := "/v1/users/1/workouts"
				var body string
				if method == "POST" {
					body = programJSON(t, apiclient.SaveWorkoutRequest{PerformedOn: "2026-10-01", Name: tc.value, Type: "upper", RawText: "original", Source: "mobile", SourceRef: testProgramID})
				} else {
					path += "/7"
					body = programJSON(t, apiclient.UpdateWorkoutRequest{PerformedOn: "2026-10-01", Name: tc.value, Type: "upper", RawText: "original", ExpectedUpdatedAt: revision})
				}
				want := tc.status
				if method == "POST" && want == 200 {
					want = 201
				}
				w := request(r, method, path, body, "Bearer native", "", "", "application/json")
				if w.Code != want {
					t.Fatalf("status %d want %d: %s", w.Code, want, w.Body.String())
				}
				if want == 400 {
					if f.calls != 0 {
						t.Fatal("invalid name reached store")
					}
					return
				}
				name := f.save.Name
				legacy := f.save.Type
				if method == "PUT" {
					name = f.update.Name
					legacy = f.update.Type
				}
				if (name == nil) != (tc.value == nil) || (name != nil && *name != tc.want) || legacy != "upper" {
					t.Fatalf("name/type changed: %v %s", name, legacy)
				}
			})
		}
	}
}
func stringPointer(s string) *string { return &s }
