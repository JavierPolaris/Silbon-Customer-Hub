import processAllCustomers from "./updateExistingCustomers.js"; // Ajusta la ruta según tu estructura

export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      await processAllCustomers(); // Ejecuta tu lógica principal
      res.status(200).json({ message: "Procesamiento completado correctamente." });
    } catch (error) {
      console.error("Error ejecutando el script:", error);
      res.status(500).json({
        error: "Ocurrió un error ejecutando el script.",
        details: error.message,
      });
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `Método ${req.method} no permitido` });
  }
}
