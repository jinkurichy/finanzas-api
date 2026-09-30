import express from "express";
import { UsersTool } from "./tools/users.js";

const app = express();
app.use(express.json());

app.post("/agent", async (req, res) => {
  const { action, payload } = req.body;

  if (action === "users") {
    const result = await UsersTool.execute(payload);
    return res.json(result);
  }

  res.status(400).json({ error: "Acción no reconocida" });
});

app.listen(3000, () => console.log("Agente corriendo en Railway"));
