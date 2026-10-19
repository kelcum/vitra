package app.vitra.cosmetics.mixin;

import app.vitra.cosmetics.Capes;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.core.ClientAsset;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(AbstractClientPlayer.class)
abstract class AbstractClientPlayerMixin {
    @Inject(method = "getSkin", at = @At("RETURN"), cancellable = true)
    private void vitra$cape(CallbackInfoReturnable<PlayerSkin> cir) {
        ClientAsset.Texture cape = Capes.textureFor(((AbstractClientPlayer) (Object) this).getUUID());
        if (cape == null) return;
        PlayerSkin skin = cir.getReturnValue();
        cir.setReturnValue(new PlayerSkin(skin.body(), cape, cape, skin.model(), skin.secure()));
    }
}
