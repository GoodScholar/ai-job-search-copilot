ALTER TABLE "recommendation_exclusions" ALTER COLUMN "recommendation_list_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendation_exclusions" ADD CONSTRAINT "recommendation_exclusions_owner_list_fk" FOREIGN KEY ("user_id","recommendation_list_id") REFERENCES "recommendation_lists"("user_id","id");
