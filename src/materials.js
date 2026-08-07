import * as THREE from 'three';

/**
 * Materiale davvero non illuminato (S1).
 *
 * In WebGPU `MeshBasicMaterial` **non** è unlit. three lo converte in
 * `MeshBasicNodeMaterial`, che dichiara `lights = true` con questo commento:
 * «Although the basic material is by definition unlit, we set this property to
 * true since we use a lighting model to compute the outgoing light». Quel
 * modello è `BasicLightingModel`, e il suo `indirect()` fa:
 *
 *     reflectedLight.indirectDiffuse.addAssign( vec4( 1.0, 1.0, 1.0, 0.0 ) );
 *     reflectedLight.indirectDiffuse.mulAssign( ambientOcclusion );   ← qui
 *     reflectedLight.indirectDiffuse.mulAssign( diffuseColor.rgb );
 *
 * `ambientOcclusion` viene dal contesto che la pipeline monta sulla scene pass
 * (`builtinAOContext`), cioè dalla GTAO. Risultato: tutto ciò che nel gioco è
 * pensato come emissivo — occhi e anelli dei droni, insegne al neon, accenti
 * delle armi, tracer, pickup — veniva moltiplicato per l'occlusione ambientale
 * e usciva più scuro di quanto il codice dichiari. Sulla luna, un disco isolato
 * col cielo trenta unità dietro, l'AO valeva quasi zero e il disco era **nero**.
 *
 * Con `lights = false` `setupLighting` salta il modello e usa direttamente
 * l'override di `setupOutgoingLight()` di MeshBasicNodeMaterial, che ritorna
 * `diffuseColor.rgb`. Nessun'altra proprietà cambia: i parametri sono gli stessi
 * di MeshBasicMaterial, da cui MeshBasicNodeMaterial eredita i default.
 *
 * Nota: `toneMapped` non esiste nel renderer WebGPU — il tone mapping è
 * applicato una volta sola da `renderOutput()` nella pipeline. Passarlo qui è
 * innocuo ma inerte, come lo era già prima.
 */
export function unlitBasic(parameters) {
  const material = new THREE.MeshBasicNodeMaterial(parameters);
  material.lights = false;
  return material;
}
