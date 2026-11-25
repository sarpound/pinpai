import { initBotId } from "botid/client/core";

// BotID: invisible bot check on the buttons that spend AI money
initBotId({
  protect: [
    { path: "/api/trips", method: "POST" },
    { path: "/api/trips/*/plan", method: "POST" },
    { path: "/api/trips/*/import", method: "POST" },
  ],
});
