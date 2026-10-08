package net.transcendiant.primordium;

import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

/**
 * Verifies the Capacitor web assets were synced into the Android project.
 * Unit tests run with the module dir (android/app) as working directory.
 */
public class WebAssetsUnitTest {

    private static final File ASSETS_DIR = new File("src/main/assets");
    private static final File PUBLIC_DIR = new File(ASSETS_DIR, "public");

    @Test
    public void webAssetsAreSynced() throws Exception {
        for (String asset : new String[] { "index.html", "dist/bundle.js", "dist/worker.js" }) {
            File f = new File(PUBLIC_DIR, asset);
            assertTrue("missing synced asset: " + f, f.isFile());
            assertTrue("empty synced asset: " + f, f.length() > 0);
        }
    }

    @Test
    public void indexReferencesBundle() throws Exception {
        String html =
                new String(
                        Files.readAllBytes(new File(PUBLIC_DIR, "index.html").toPath()),
                        StandardCharsets.UTF_8);
        assertTrue("index.html does not reference dist/bundle.js", html.contains("dist/bundle.js"));
    }

    @Test
    public void appIdIsConfigured() throws Exception {
        String json =
                new String(
                        Files.readAllBytes(
                                new File(ASSETS_DIR, "capacitor.config.json").toPath()),
                        StandardCharsets.UTF_8);
        assertTrue(
                "capacitor.config.json has unexpected appId",
                json.contains("\"appId\": \"net.transcendiant.primordium\""));
    }
}
