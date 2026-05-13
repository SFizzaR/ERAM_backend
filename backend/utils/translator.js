const translateSmart = async (text, targetLang = "ur") => {
  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;

  try {
    if (!endpoint || !key || !region) {
      console.error("Missing Azure env variables");
      return text;
    }

    const baseEndpoint = endpoint.endsWith("/")
      ? endpoint
      : `${endpoint}/`;

    const url = `${baseEndpoint}translate?api-version=3.0&to=${targetLang}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": key,
        "Ocp-Apim-Subscription-Region": region,
      },
      body: JSON.stringify([{ Text: text }]),
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error("Translation failed:", response.status, raw);
      return text;
    }

    const data = JSON.parse(raw);

    return data?.[0]?.translations?.[0]?.text || text;
  } catch (error) {
    console.error("Translation error:", error);
    return text;
  }
};

module.exports = { translateSmart };