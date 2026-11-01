package server

import (
	"context"
	"encoding/json"
	"reflect"
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
	programs      []apiclient.Program
	created       bool
}

func (f *programStoreFake) ListPrograms(context.Context, int64) (apiclient.ListProgramsResponse, error) {
	f.calls++
	programs := f.programs
	if programs == nil {
		programs = []apiclient.Program{}
	}
	return apiclient.ListProgramsResponse{Programs: programs}, f.mutationErr
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
		body := `{"id":"` + testProgramID + `","name":"Push","entries":[{"name":"Bench","set_count":3,"target_reps_min":6,"target_reps_max":8}]}`
		if method == "PUT" || method == "DELETE" {
			path += "/" + testProgramID
			body = `{"name":"Push","entries":[{"name":"Bench","set_count":3,"target_reps_min":6,"target_reps_max":8}],"expected_updated_at":"` + revision.Format(time.RFC3339Nano) + `"}`
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

func TestProgramRangeHTTPRoundTrip(t *testing.T) {
	f := &programStoreFake{created: true}
	r := programRouter(t, f)
	path := "/v1/users/1/programs"
	body := `{"id":"` + testProgramID + `","name":"Push","entries":[{"name":"Bench","set_count":3,"target_reps_min":6,"target_reps_max":8},{"name":"Dips","set_count":2,"target_reps":10},{"name":"Plank","set_count":1}]}`
	w := request(r, "POST", path, body, "Bearer native", "", "", "application/json")
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var p apiclient.Program
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	min, max, single := 6, 8, 10
	want := []apiclient.ProgramEntry{
		{Name: "Bench", SetCount: 3, TargetRepsMin: &min, TargetRepsMax: &max},
		{Name: "Dips", SetCount: 2, TargetReps: &single},
		{Name: "Plank", SetCount: 1},
	}
	if !reflect.DeepEqual(p.Entries, want) || !reflect.DeepEqual(f.program.Entries, want) {
		t.Fatalf("POST lost targets: response=%+v stored=%+v", p.Entries, f.program.Entries)
	}
	checkList := func() {
		t.Helper()
		f.programs = []apiclient.Program{p}
		w := request(r, "GET", path, "", "Bearer native", "", "", "")
		var list apiclient.ListProgramsResponse
		if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || w.Code != 200 || !reflect.DeepEqual(list.Programs, []apiclient.Program{p}) {
			t.Fatalf("GET lost targets: %d %s %v", w.Code, w.Body.String(), err)
		}
	}
	checkList()
	// Update the range without collapsing it, and replace a legacy single target
	// with a range while clearing the first entry's old range on a later PUT.
	for _, entries := range [][]apiclient.ProgramEntry{
		{{Name: "Bench", SetCount: 3, TargetRepsMin: &max, TargetRepsMax: &single}},
		{{Name: "Bench", SetCount: 3, TargetReps: &single}, {Name: "Dips", SetCount: 2, TargetRepsMin: &min, TargetRepsMax: &max}},
	} {
		edit := apiclient.UpdateProgramRequest{Name: p.Name, Entries: entries, ExpectedUpdatedAt: p.UpdatedAt}
		w = request(r, "PUT", path+"/"+testProgramID, programJSON(t, edit), "Bearer native", "", "", "application/json")
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || w.Code != 200 || !reflect.DeepEqual(p.Entries, entries) || !reflect.DeepEqual(f.programUpdate.Entries, entries) {
			t.Fatalf("PUT lost targets: %d %s %v", w.Code, w.Body.String(), err)
		}
		checkList()
	}
}

func TestProgramRangeValidation(t *testing.T) {
	for _, tc := range []struct {
		name, fields string
		valid        bool
	}{
		{"absent", ``, true},
		{"null", `,"target_reps":null,"target_reps_min":null,"target_reps_max":null`, true},
		{"legacy single", `,"target_reps":8`, true},
		{"range", `,"target_reps_min":6,"target_reps_max":8`, true},
		{"equal bounds", `,"target_reps_min":8,"target_reps_max":8`, true},
		{"inclusive limits", `,"target_reps_min":1,"target_reps_max":9999`, true},
		{"only min", `,"target_reps_min":6`, false},
		{"only max", `,"target_reps_max":8`, false},
		{"null min", `,"target_reps_min":null,"target_reps_max":8`, false},
		{"null max", `,"target_reps_min":6,"target_reps_max":null`, false},
		{"reversed", `,"target_reps_min":8,"target_reps_max":6`, false},
		{"zero min", `,"target_reps_min":0,"target_reps_max":8`, false},
		{"negative min", `,"target_reps_min":-1,"target_reps_max":8`, false},
		{"zero max", `,"target_reps_min":1,"target_reps_max":0`, false},
		{"negative max", `,"target_reps_min":1,"target_reps_max":-1`, false},
		{"excess min", `,"target_reps_min":10000,"target_reps_max":10000`, false},
		{"excess max", `,"target_reps_min":6,"target_reps_max":10000`, false},
		{"combined targets", `,"target_reps":8,"target_reps_min":6,"target_reps_max":8`, false},
		{"single with min", `,"target_reps":8,"target_reps_min":6`, false},
		{"single with max", `,"target_reps":8,"target_reps_max":8`, false},
		{"string min", `,"target_reps_min":"6","target_reps_max":8`, false},
		{"string max", `,"target_reps_min":6,"target_reps_max":"8"`, false},
		{"fraction min", `,"target_reps_min":6.5,"target_reps_max":8`, false},
		{"fraction max", `,"target_reps_min":6,"target_reps_max":8.5`, false},
		{"boolean min", `,"target_reps_min":true,"target_reps_max":8`, false},
		{"overflow max", `,"target_reps_min":6,"target_reps_max":999999999999999999999`, false},
	} {
		for _, method := range []string{"POST", "PUT"} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				path := "/v1/users/1/programs"
				body := `{"name":"Push","entries":[{"name":"Bench","set_count":3` + tc.fields + `}]`
				if method == "POST" {
					body += `,"id":"` + testProgramID + `"}`
				} else {
					path += "/" + testProgramID
					body += `,"expected_updated_at":"` + revision.Format(time.RFC3339Nano) + `"}`
				}
				f := &programStoreFake{}
				w := request(programRouter(t, f), method, path, body, "Bearer native", "", "", "application/json")
				if tc.valid {
					if w.Code != 200 || f.calls != 1 {
						t.Fatalf("valid targets rejected: %d %s calls=%d", w.Code, w.Body.String(), f.calls)
					}
				} else if w.Code != 400 || f.calls != 0 || !strings.Contains(w.Body.String(), `"error":"invalid_request"`) {
					t.Fatalf("invalid targets accepted: %d %s calls=%d", w.Code, w.Body.String(), f.calls)
				}
			})
		}
	}
}
