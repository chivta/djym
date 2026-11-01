package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"gymbro/internal/apiclient"
)

type documentedOperation struct {
	OperationID string                      `json:"operationId"`
	Security    []map[string][]string       `json:"security"`
	Responses   map[string]json.RawMessage  `json:"responses"`
	RequestBody json.RawMessage             `json:"requestBody"`
	Parameters  []struct{ Name, In string } `json:"parameters"`
}

type documentedSchema struct {
	Properties           map[string]json.RawMessage `json:"properties"`
	AdditionalProperties *bool                      `json:"additionalProperties"`
	Required             []string                   `json:"required"`
	Description          string                     `json:"description"`
}

type openAPIDocument struct {
	OpenAPI    string                                    `json:"openapi"`
	Paths      map[string]map[string]documentedOperation `json:"paths"`
	Components struct {
		Schemas         map[string]documentedSchema `json:"schemas"`
		SecuritySchemes map[string]struct {
			Type, Scheme, In, Name string
		} `json:"securitySchemes"`
	} `json:"components"`
}

func docsRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	v, err := newValidator()
	if err != nil {
		t.Fatal(err)
	}
	f := &mobileStoreFake{}
	return newRouter("bot-secret", f, &handlers{store: f, validate: v}, func(c *gin.Context) { c.Status(http.StatusOK) })
}

func loadOpenAPI(t *testing.T) openAPIDocument {
	t.Helper()
	w := request(docsRouter(t), http.MethodGet, "/swagger/openapi.json", "", "", "", "", "")
	var spec openAPIDocument
	if err := json.Unmarshal(w.Body.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.0.3" {
		t.Fatalf("unexpected OpenAPI version %q", spec.OpenAPI)
	}
	return spec
}

func TestSwaggerPublicRoutes(t *testing.T) {
	r := docsRouter(t)
	for _, path := range []string{"/swagger/index.html", "/swagger/openapi.json"} {
		for _, auth := range []string{"", "Bearer invalid", "malformed"} {
			w := request(r, http.MethodGet, path, "", auth, "stale-cookie", "", "")
			if w.Code != http.StatusOK {
				t.Fatalf("%s with auth %q: %d", path, auth, w.Code)
			}
			if w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("%s missing nosniff", path)
			}
			if strings.HasSuffix(path, ".html") {
				if !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || !strings.Contains(w.Body.String(), "SwaggerUIBundle") || !strings.Contains(w.Body.String(), `url: "/swagger/openapi.json"`) || !strings.Contains(w.Body.String(), "validatorUrl: null") {
					t.Fatal("UI is not configured to use the local spec without a remote validator")
				}
			} else if !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
				t.Fatal("spec not served as JSON")
			}
		}
	}
	for _, path := range []string{"/swagger", "/swagger/"} {
		w := request(r, http.MethodGet, path, "", "Bearer invalid", "", "", "")
		if w.Code != http.StatusMovedPermanently || w.Header().Get("Location") != "/swagger/index.html" {
			t.Fatalf("%s: missing UI redirect", path)
		}
	}
	w := request(r, http.MethodGet, "/health", "", "Bearer invalid", "", "", "")
	if w.Code != http.StatusUnauthorized {
		t.Fatal("health authentication behavior changed")
	}
}

func TestOpenAPIRouteCoverageAndAuthentication(t *testing.T) {
	spec := loadOpenAPI(t)
	r := docsRouter(t)
	seen := map[string]bool{}
	operationIDs := map[string]bool{}
	public := map[string]bool{
		"GET /health":                      true,
		"POST /auth/telegram/login":        true,
		"POST /auth/telegram/poll":         true,
		"POST /auth/telegram/mobile/login": true,
		"POST /auth/telegram/mobile/poll":  true,
	}
	serviceOnly := map[string]bool{
		"POST /v1/identities/resolve":           true,
		"POST /v1/auth/telegram/confirm":        true,
		"GET /v1/users/{id}/exercises":          true,
		"POST /v1/users/{id}/exercises/replace": true,
	}
	for _, route := range r.Routes() {
		if strings.HasPrefix(route.Path, "/swagger") {
			continue
		}
		path := route.Path
		for _, param := range []string{"id", "workout_id", "program_id"} {
			path = strings.ReplaceAll(path, ":"+param, "{"+param+"}")
		}
		key := route.Method + " " + path
		op, ok := spec.Paths[path][strings.ToLower(route.Method)]
		if !ok {
			t.Errorf("undocumented route %s", key)
			continue
		}
		seen[key] = true
		if op.OperationID == "" || operationIDs[op.OperationID] {
			t.Errorf("missing or duplicate operationId for %s", key)
		}
		operationIDs[op.OperationID] = true
		if len(op.Responses) == 0 {
			t.Errorf("no responses for %s", key)
		}
		wantSecurity := []map[string][]string{{"ServiceBearer": {}}, {"SessionBearer": {}}, {"SessionCookie": {}}}
		switch {
		case key == "POST /auth/telegram/poll":
			wantSecurity = []map[string][]string{{"LoginCookie": {}}}
		case public[key]:
			wantSecurity = []map[string][]string{}
		case serviceOnly[key]:
			wantSecurity = []map[string][]string{{"ServiceBearer": {}}}
		case strings.HasPrefix(path, "/auth/"):
			wantSecurity = []map[string][]string{{"SessionBearer": {}}, {"SessionCookie": {}}}
		}
		if !reflect.DeepEqual(op.Security, wantSecurity) {
			t.Errorf("incorrect security for %s: got %v, want %v", key, op.Security, wantSecurity)
		}
		for _, field := range []string{"id", "workout_id", "program_id"} {
			if strings.Contains(path, "{"+field+"}") {
				found := false
				for _, param := range op.Parameters {
					found = found || param.In == "path" && param.Name == field
				}
				if !found {
					t.Errorf("%s missing path parameter %s", key, field)
				}
			}
		}
		if !public[key] {
			w := request(r, route.Method, route.Path, "", "", "", "", "")
			if w.Code != http.StatusUnauthorized {
				t.Errorf("anonymous API access to %s: %d", key, w.Code)
			}
		}
		// Invalid bearer credentials still fail on every non-documentation route.
		w := request(r, route.Method, route.Path, "", "Bearer invalid", "", "", "")
		if w.Code != http.StatusUnauthorized {
			t.Errorf("invalid bearer accepted on %s: %d", key, w.Code)
		}
	}
	for path, methods := range spec.Paths {
		for method := range methods {
			key := strings.ToUpper(method) + " " + path
			if !seen[key] {
				t.Errorf("spec documents unregistered route %s", key)
			}
		}
	}
	for _, name := range []string{"ServiceBearer", "SessionBearer"} {
		scheme := spec.Components.SecuritySchemes[name]
		if scheme.Type != "http" || scheme.Scheme != "bearer" {
			t.Errorf("incorrect bearer security scheme %s", name)
		}
	}
	for name, cookie := range map[string]string{"SessionCookie": sessionCookie, "LoginCookie": loginCookie} {
		scheme := spec.Components.SecuritySchemes[name]
		if scheme.Type != "apiKey" || scheme.In != "cookie" || scheme.Name != cookie {
			t.Errorf("incorrect cookie security scheme %s", name)
		}
	}
}

func TestOpenAPISchemasMatchWireFields(t *testing.T) {
	spec := loadOpenAPI(t)
	for _, wire := range []any{
		apiclient.ResolveIdentityRequest{}, apiclient.ResolveIdentityResponse{},
		apiclient.SaveWorkoutRequest{}, apiclient.UpdateWorkoutRequest{},
		apiclient.Entry{}, apiclient.Set{}, apiclient.SaveWorkoutResponse{},
		apiclient.Exercise{}, apiclient.ListExercisesResponse{}, apiclient.ReplaceExerciseRequest{}, apiclient.ReplaceExerciseResponse{},
		apiclient.Workout{}, apiclient.WorkoutEntry{}, apiclient.ListWorkoutsResponse{},
		apiclient.ConfirmLoginRequest{}, apiclient.StartLoginResponse{}, apiclient.PollLoginResponse{}, apiclient.MeResponse{},
		apiclient.StartMobileLoginResponse{}, apiclient.PollMobileLoginRequest{}, apiclient.PollMobileLoginResponse{},
		apiclient.ProgramEntry{}, apiclient.Program{}, apiclient.CreateProgramRequest{}, apiclient.UpdateProgramRequest{},
		apiclient.DeleteProgramRequest{}, apiclient.ListProgramsResponse{},
	} {
		typ := reflect.TypeOf(wire)
		schema, ok := spec.Components.Schemas[typ.Name()]
		if !ok {
			t.Errorf("missing schema %s", typ.Name())
			continue
		}
		if len(schema.Properties) != typ.NumField() {
			t.Errorf("%s: documented properties differ from wire fields", typ.Name())
		}
		for i := 0; i < typ.NumField(); i++ {
			field := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
			if _, ok := schema.Properties[field]; !ok {
				t.Errorf("%s: missing property %s", typ.Name(), field)
			}
		}
	}
	for _, name := range []string{"UpdateWorkoutRequest", "CreateProgramRequest", "UpdateProgramRequest", "DeleteProgramRequest"} {
		strict := spec.Components.Schemas[name].AdditionalProperties
		if strict == nil || *strict {
			t.Errorf("%s must document rejection of unknown fields", name)
		}
	}
	// The same production router must also preserve actual bearer authorization.
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.Header.Set("Authorization", "Bearer native")
	docsRouter(t).ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"user_id":1`) {
		t.Fatal("session bearer no longer works")
	}
}

func TestOpenAPIWorkoutCRUDContract(t *testing.T) {
	spec := loadOpenAPI(t)
	post := spec.Paths["/v1/users/{id}/workouts"]["post"]
	if _, ok := post.Responses["201"]; !ok {
		t.Fatal("POST must document creation")
	}
	if _, ok := post.Responses["200"]; ok {
		t.Fatal("POST must not document replay/upsert")
	}
	mutations := spec.Paths["/v1/users/{id}/workouts/{workout_id}"]
	for _, op := range []documentedOperation{post, mutations["put"], mutations["delete"]} {
		if _, ok := op.Responses["409"]; ok {
			t.Fatal("workout mutation documents obsolete revision/replay conflict")
		}
	}
	if len(mutations["delete"].RequestBody) != 0 {
		t.Fatal("DELETE must not require a body")
	}
	if _, ok := spec.Components.Schemas["DeleteWorkoutRequest"]; ok {
		t.Fatal("obsolete DELETE revision schema")
	}
	if _, ok := spec.Components.Schemas["UpdateWorkoutRequest"].Properties["expected_updated_at"]; ok {
		t.Fatal("obsolete PUT revision token")
	}
	// Programs deliberately keep their independent revision contract.
	if _, ok := spec.Components.Schemas["UpdateProgramRequest"].Properties["expected_updated_at"]; !ok {
		t.Fatal("program revision was removed")
	}
}

func TestOpenAPIProgramRepTargets(t *testing.T) {
	schema := loadOpenAPI(t).Components.Schemas["ProgramEntry"]
	for _, name := range []string{"target_reps", "target_reps_min", "target_reps_max"} {
		var field struct {
			Type             string
			Minimum, Maximum int
			Nullable         bool
		}
		if err := json.Unmarshal(schema.Properties[name], &field); err != nil {
			t.Fatal(err)
		}
		if field.Type != "integer" || field.Minimum != 1 || field.Maximum != apiclient.MaxProgramTargetReps || !field.Nullable {
			t.Errorf("incorrect rep constraints for %s: %+v", name, field)
		}
		for _, required := range schema.Required {
			if required == name {
				t.Errorf("%s must remain optional", name)
			}
		}
	}
	for _, rule := range []string{"Both range bounds", "minimum must not exceed maximum", "target_reps cannot be combined with a range"} {
		if !strings.Contains(schema.Description, rule) {
			t.Errorf("missing program range contract: %s", rule)
		}
	}
}
