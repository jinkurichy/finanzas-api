import axios from "axios";

export const UsersTool = {
  name: "users_tool",
  description: "Accede a la API de usuarios",
  execute: async ({ endpoint, method = "GET", data }) => {
    const url = process.env.API_FINANZAS_URL + endpoint;

    try {
      const res = await axios({
        url,
        method,
        data
      });

      return res.data;
    } catch (err) {
      return { error: err.message };
    }
  }
};
