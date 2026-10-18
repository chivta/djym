package store

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/tern/v2/migrate"
)

func TestWorkoutProgramMigrationPostgres(t *testing.T) {
	_, pool, ctx := localMobileStore(t)
	schema := fmt.Sprintf("program_migration_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Error(err)
		}
	}()
	// Tern resets session settings between migrations, so use a connection startup
	// parameter rather than SET search_path to keep every migration isolated.
	cfg := pool.Config().ConnConfig.Copy()
	cfg.RuntimeParams["search_path"] = schema
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	m, err := migrate.NewMigrator(ctx, conn, schema+".schema_version")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.LoadMigrations(os.DirFS("../database/migrations")); err != nil {
		t.Fatal(err)
	}
	if err := m.MigrateTo(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO users(id) VALUES(1);
 INSERT INTO workouts(user_id,performed_on,workout_type,kcal,protein_g,note,raw_text,source,source_ref,updated_at)
 VALUES(1,'2026-10-01','upper',2000,130,'keep note','original','telegram','1','2026-10-01T12:00:00Z'),
 (1,'2026-10-02',NULL,NULL,NULL,NULL,'empty type','mobile','2','2026-10-02T12:00:00Z');
 INSERT INTO exercises(id,user_id,name) VALUES(1,1,'Bench');
 INSERT INTO workout_exercises(id,workout_id,exercise_id,position,name_as_written) VALUES(1,1,1,1,'Written bench');
 INSERT INTO exercise_sets(workout_exercise_id,position,weight_kg,reps) VALUES(1,1,60,8)`); err != nil {
		t.Fatal(err)
	}
	snapshot := func(withName bool) string {
		t.Helper()
		expr := "to_jsonb(w)"
		if withName {
			expr = "(to_jsonb(w)-'name')"
		}
		var s string
		if err := conn.QueryRow(ctx, `SELECT jsonb_build_object('workouts',(SELECT jsonb_agg(`+expr+` ORDER BY id) FROM workouts w),'entries',(SELECT jsonb_agg(e ORDER BY id) FROM workout_exercises e),'sets',(SELECT jsonb_agg(s ORDER BY id) FROM exercise_sets s))::text`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	before := snapshot(false)
	if err := m.MigrateTo(ctx, 4); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(true); after != before {
		t.Fatalf("migration rewrote identity/content/revisions:\n%s\n%s", before, after)
	}
	var names []string
	if err := conn.QueryRow(ctx, `SELECT array_agg(name ORDER BY id) FROM workouts`).Scan(&names); err != nil || len(names) != 2 || names[0] != "upper" || names[1] != "" {
		t.Fatalf("backfill: %v %v", names, err)
	}
	if err := m.MigrateTo(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(false); after != before {
		t.Fatal("rollback changed original rows")
	}
}
