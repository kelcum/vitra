package app.vitra.cosmetics;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Downloads Vitra capes and turns each animation frame into a texture. The cape handed to the
 * renderer picks the current frame every time it's drawn, so animated capes play by themselves.
 */
public final class Capes {
    private static final Map<String, ClientAsset.Texture> loaded = new ConcurrentHashMap<>();
    private static final Set<String> started = ConcurrentHashMap.newKeySet();
    private static final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();

    private Capes() {}

    /** The texture to draw as this player's cape, or null to leave their cape alone (still loading, or no Vitra cape). */
    public static ClientAsset.Texture textureFor(UUID player) {
        Directory.Cape cape = Directory.cape(player);
        if (cape == null) return null;
        ClientAsset.Texture tex = loaded.get(cape.id());
        if (tex == null && started.add(cape.id())) download(cape);
        return tex;
    }

    private static void download(Directory.Cape cape) {
        HttpRequest req = HttpRequest.newBuilder(URI.create(cape.url())).timeout(Duration.ofSeconds(20))
            .header("user-agent", "VitraCosmetics/1.0").build();
        http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray()).whenComplete((res, err) -> {
            if (err != null || res.statusCode() != 200) {
                VitraCosmetics.LOG.warn("Couldn't download cape {}: {}", cape.id(), err != null ? err.toString() : "HTTP " + res.statusCode());
                started.remove(cape.id());                     // try again next time it's needed
                return;
            }
            Minecraft.getInstance().execute(() -> register(cape, res.body()));
        });
    }

    /** Splits the image into frames (stacked top to bottom) and registers one texture per frame. Game thread only. */
    private static void register(Directory.Cape cape, byte[] png) {
        try (NativeImage all = NativeImage.read(png)) {
            int w = all.getWidth(), frameH = w / 2;
            int frames = Math.max(1, Math.min(cape.frames(), all.getHeight() / frameH));
            Identifier[] ids = new Identifier[frames];
            for (int i = 0; i < frames; i++) {
                NativeImage frame = new NativeImage(w, frameH, true);
                all.copyRect(frame, 0, i * frameH, 0, 0, w, frameH, false, false);
                ids[i] = Identifier.fromNamespaceAndPath("vitra", "capes/" + cape.id() + "/" + i);
                int n = i;
                Minecraft.getInstance().getTextureManager().register(ids[i], new DynamicTexture(() -> "Vitra cape " + cape.id() + " #" + n, frame));
            }
            loaded.put(cape.id(), new Animated(ids[0], ids, Math.max(20, cape.delay())));
        } catch (Exception e) {
            VitraCosmetics.LOG.warn("Couldn't read cape {}", cape.id(), e);
        }
    }

    /** A cape texture that shows a different frame depending on the time. */
    private record Animated(Identifier id, Identifier[] frames, int delay) implements ClientAsset.Texture {
        @Override
        public Identifier texturePath() {
            if (frames.length == 1) return frames[0];
            return frames[(int) ((System.currentTimeMillis() / delay) % frames.length)];
        }
    }
}
