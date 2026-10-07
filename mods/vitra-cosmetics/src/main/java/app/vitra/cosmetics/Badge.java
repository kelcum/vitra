package app.vitra.cosmetics;

import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.FontDescription;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.resources.Identifier;

import java.util.UUID;

/**
 * The little Vitra cube put in front of a Vitra player's name. The owner's is animated: 16 glyphs in
 * the badge font, one per frame, picked by the clock every time the name is drawn.
 */
public final class Badge {
    /** Glyphs from assets/vitra/font/badge.json, drawn in their own colours (white means "don't tint"). */
    private static final Style STYLE = Style.EMPTY
        .withFont(new FontDescription.Resource(Identifier.fromNamespaceAndPath("vitra", "badge")))
        .withColor(0xFFFFFF)
        .withoutShadow();
    private static final Component VITRA = Component.literal("\uE000").setStyle(STYLE);
    private static final Component[] OWNER = new Component[16];
    private static final int OWNER_FRAME_MS = 75;

    static {
        for (int i = 0; i < OWNER.length; i++) OWNER[i] = Component.literal(String.valueOf((char) (0xE100 + i))).setStyle(STYLE);
    }

    private Badge() {}

    public static Component decorate(UUID player, Component name) {
        if (!VitraCosmetics.badgesAvailable || name == null) return name;
        String kind = Directory.badge(player);
        if (kind == null) return name;
        Component glyph = "owner".equals(kind) ? OWNER[(int) ((System.currentTimeMillis() / OWNER_FRAME_MS) % OWNER.length)] : VITRA;
        MutableComponent out = Component.empty();
        out.append(glyph).append(Component.literal(" ")).append(name);
        return out;
    }
}
