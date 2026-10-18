package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

const testProgramID = "cc000000-0000-4000-8000-000000000001"

type programStoreFake struct {
	mobileStoreFake
	program       apiclient.CreateProgramRequest
	programUpdate apiclient.UpdateProgramRequest
	created       bool
}

func (f *programStoreFake) ListPrograms(context.Context, int64) (apiclient.ListProgramsResponse, error) {
	f.calls++
	return apiclient.ListProgramsResponse{Programs: []apiclient.Program{}}, f.mutationErr
}
func (f *programStoreFake) CreateProgram(_ context.Context, user int64, req apiclient.CreateProgramRequest) (apiclient.Program, bool, error) {
	if user != 1 {
		panic("wrong user")
	}
	f.calls++
	f.program = req
	return apiclient.Program{ID: req.ID, Name: req.Name, Entries: req.Entries, UpdatedAt: revision}, f.created, f.mutationErr
}
func (f *programStoreFake) UpdateProgram(_ context.Context, user int64, id string, req apiclient.UpdateProgramRequest) (apiclient.Program, error) {
	if user != 1 || id != testProgramID {
		panic("wrong ownership")
	}
	f.calls++
	f.programUpdate = req
	return apiclient.Program{ID: id, Name: req.Name, Entries: req.Entries, UpdatedAt: revision}, f.mutationErr
}
func (f *programStoreFake) DeleteProgram(_ context.Context, user int64, id string, expected time.Time) error {
	if user != 1 || id != testProgramID {
		panic("wrong ownership")
	}
	f.calls++
	f.expected = expected
	return f.mutationErr
}

func programRouter(t *testing.T, f *programStoreFake) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	v, err := newValidator()
	if err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.Use(authenticate("bot-secret", f))
	h := handlers{store: f, validate: v}
	v1 := r.Group("/v1")
	h.register(v1.Group("", requireService()), v1.Group("", requireUserAccess()))
	return r
}
func programJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func TestProgramHTTP(t *testing.T) {
	f := &programStoreFake{created: true}
	r := programRouter(t, f)
	path := "/v1/users/1/programs"
	body := `{"id":"` + testProgramID + `","name":"  Push Day  ","entries":[{"name":" Bench ","set_count":3,"target_reps":8},{"name":"Dips","set_count":2,"target_reps":null}]}`
	w := request(r, "POST", path, body, "Bearer native", "", "", "application/json")
	if w.Code != 201 || f.program.Name != "Push Day" || f.program.Entries[0].Name != "Bench" || f.program.Entries[1].TargetReps != nil {
		t.Fatalf("create: %d %s %+v", w.Code, w.Body.String(), f.program)
	}
	var p apiclient.Program
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.ID != testProgramID || !p.UpdatedAt.Equal(revision) {
		t.Fatalf("response: %+v %v", p, err)
	}
	f.created = false
	if w := request(r, "POST", path, body, "Bearer native", "", "", "application/json"); w.Code != 200 {
		t.Fatalf("replay: %d", w.Code)
	}
	edit := apiclient.UpdateProgramRequest{Name: " Rename ", Entries: f.program.Entries, ExpectedUpdatedAt: revision}
	if w := request(r, "PUT", path+"/"+testProgramID, programJSON(t, edit), "Bearer native", "", "", "application/json"); w.Code != 200 || f.programUpdate.Name != "Rename" {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	f.mutationErr = apperr.ErrConflict
	if w := request(r, "PUT", path+"/"+testProgramID, programJSON(t, edit), "Bearer native", "", "", "application/json"); w.Code != 409 {
		t.Fatalf("conflict: %d", w.Code)
	}
	f.mutationErr = apperr.ErrProgramNotFound
	del := programJSON(t, apiclient.DeleteProgramRequest{ExpectedUpdatedAt: revision})
	if w := request(r, "DELETE", path+"/"+testProgramID, del, "Bearer native", "", "", "application/json"); w.Code != 404 || !strings.Contains(w.Body.String(), "program_not_found") {
		t.Fatalf("not found: %d %s", w.Code, w.Body.String())
	}
	f.mutationErr = nil
	if w := request(r, "DELETE", path+"/"+testProgramID, del, "Bearer native", "", "", "application/json"); w.Code != 204 || w.Body.Len() != 0 || !f.expected.Equal(revision) {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if w := request(r, "GET", path, "", "Bearer native", "", "", ""); w.Code != 200 || w.Body.String() != `{"programs":[]}` {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
}

func TestProgramAuthorization(t *testing.T) {
	for _, method := range []string{"GET", "POST", "PUT", "DELETE"} {
		path := "/v1/users/1/programs"
		body := `{"id":"` + testProgramID + `","name":"Push","entries":[{"name":"Bench","set_count":1}]}`
		if method == "PUT" || method == "DELETE" {
			path += "/" + testProgramID
			body = `{"name":"Push","entries":[{"name":"Bench","set_count":1}],"expected_updated_at":"` + revision.Format(time.RFC3339Nano) + `"}`
			if method == "DELETE" {
				body = `{"expected_updated_at":"` + revision.Format(time.RFC3339Nano) + `"}`
			}
		}
		for _, tc := range []struct {
			name, auth, cookie, csrf, ctype string
			status                          int
		}{
			{"anonymous", "", "", "", "application/json", 401},
			{"foreign", "Bearer native", "", "", "application/json", 403},
			{"native", "Bearer native", "", "", "application/json", 200},
			{"service", "Bearer bot-secret", "", "", "application/json", 200},
			{"cookie no header", "", "cookie", "", "application/json", 403},
			{"cookie form", "", "cookie", "1", "text/plain", 403},
			{"cookie protected", "", "cookie", "1", "application/json", 200},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				f := &programStoreFake{}
				p := path
				if tc.name == "foreign" {
					p = strings.Replace(p, "/users/1/", "/users/2/", 1)
				}
				want := tc.status
				if method == "GET" && strings.HasPrefix(tc.name, "cookie") {
					want = 200
				}
				if method == "DELETE" && want == 200 {
					want = 204
				}
				w := request(programRouter(t, f), method, p, body, tc.auth, tc.cookie, tc.csrf, tc.ctype)
				if w.Code != want {
					t.Fatalf("status %d want %d: %s", w.Code, want, w.Body.String())
				}
				if want >= 400 && f.calls != 0 {
					t.Fatal("unauthorized request reached store")
				}
			})
		}
	}
}

func TestProgramValidation(t *testing.T) {
	valid := apiclient.CreateProgramRequest{ID: testProgramID, Name: "Push", Entries: []apiclient.ProgramEntry{{Name: "Bench", SetCount: 1}}}
	cases := []struct {
		name   string
		change func(*apiclient.CreateProgramRequest)
	}{
		{"blank name", func(r *apiclient.CreateProgramRequest) { r.Name = " \n " }},
		{"long name", func(r *apiclient.CreateProgramRequest) { r.Name = strings.Repeat("я", 2001) }},
		{"no entries", func(r *apiclient.CreateProgramRequest) { r.Entries = nil }},
		{"too many", func(r *apiclient.CreateProgramRequest) { r.Entries = make([]apiclient.ProgramEntry, 101) }},
		{"blank exercise", func(r *apiclient.CreateProgramRequest) { r.Entries[0].Name = " \t " }},
		{"long exercise", func(r *apiclient.CreateProgramRequest) { r.Entries[0].Name = strings.Repeat("я", 2001) }},
		{"zero sets", func(r *apiclient.CreateProgramRequest) { r.Entries[0].SetCount = 0 }},
		{"excess sets", func(r *apiclient.CreateProgramRequest) { r.Entries[0].SetCount = 101 }},
		{"zero reps", func(r *apiclient.CreateProgramRequest) { v := 0; r.Entries[0].TargetReps = &v }},
		{"excess reps", func(r *apiclient.CreateProgramRequest) { v := 10000; r.Entries[0].TargetReps = &v }},
		{"invalid ID", func(r *apiclient.CreateProgramRequest) { r.ID = "bad" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := valid
			req.Entries = append([]apiclient.ProgramEntry{}, valid.Entries...)
			tc.change(&req)
			f := &programStoreFake{}
			w := request(programRouter(t, f), "POST", "/v1/users/1/programs", programJSON(t, req), "Bearer native", "", "", "application/json")
			if w.Code != 400 || f.calls != 0 {
				t.Fatalf("validation: %d %s", w.Code, w.Body.String())
			}
		})
	}
	max := valid
	max.Name = strings.Repeat("я", 2000)
	reps := 9999
	max.Entries = make([]apiclient.ProgramEntry, 100)
	for i := range max.Entries {
		max.Entries[i] = apiclient.ProgramEntry{Name: max.Name, SetCount: 100, TargetReps: &reps}
	}
	if w := request(programRouter(t, &programStoreFake{}), "POST", "/v1/users/1/programs", programJSON(t, max), "Bearer native", "", "", "application/json"); w.Code != 200 {
		t.Fatalf("inclusive bounds: %d %s", w.Code, w.Body.String())
	}
	for _, body := range []string{`{}`, `{"id":"` + testProgramID + `","name":"Push","entries":[],"extra":true}`, programJSON(t, valid) + ` {}`, `{"id":"` + testProgramID + `","name":"Push","entries":[{"name":"Bench","set_count":1,"target_reps":""}]}`} {
		if w := request(programRouter(t, &programStoreFake{}), "POST", "/v1/users/1/programs", body, "Bearer native", "", "", "application/json"); w.Code != 400 {
			t.Fatalf("invalid JSON accepted: %d %s", w.Code, w.Body.String())
		}
	}
	for _, method := range []string{"PUT", "DELETE"} {
		if w := request(programRouter(t, &programStoreFake{}), method, "/v1/users/1/programs/"+testProgramID, `{"name":"Push","entries":[{"name":"Bench","set_count":1}]}`, "Bearer native", "", "", "application/json"); w.Code != 400 {
			t.Fatalf("missing revision accepted: %d", w.Code)
		}
	}
}
