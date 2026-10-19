package app.vitra.cosmetics.mixin;

import app.vitra.cosmetics.Badge;
import net.minecraft.client.gui.components.PlayerTabOverlay;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(PlayerTabOverlay.class)
abstract class PlayerTabOverlayMixin {
    @Inject(method = "getNameForDisplay", at = @At("RETURN"), cancellable = true)
    private void vitra$badge(PlayerInfo info, CallbackInfoReturnable<Component> cir) {
        cir.setReturnValue(Badge.decorate(info.getProfile().id(), cir.getReturnValue()));
    }
}
