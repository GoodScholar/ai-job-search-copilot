CREATE FUNCTION "enforce_recommendation_highlight_limit"() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "recommendation_list_items" WHERE "recommendation_list_id" = NEW."recommendation_list_id" AND "highlighted") > 3 THEN
    RAISE EXCEPTION 'recommendation lists may highlight at most three items';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "recommendation_list_items_highlight_limit"
AFTER INSERT OR UPDATE OF "highlighted", "recommendation_list_id" ON "recommendation_list_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_recommendation_highlight_limit"();
