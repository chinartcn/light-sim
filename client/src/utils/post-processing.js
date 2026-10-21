import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export class PostProcessing {
  constructor(renderer, scene, camera) {
    this.composer = new EffectComposer(renderer);
    
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    
    this.ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
    this.ssaoPass.kernelRadius = 0.8;
    this.ssaoPass.minDistance = 0.005; 
    this.ssaoPass.maxDistance = 0.1;
    this.ssaoPass.enabled = false;
    this.composer.addPass(this.ssaoPass);
    
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  setSSAO(enabled) { this.ssaoPass.enabled = enabled; }
  resize(w, h) { this.composer.setSize(w, h); this.ssaoPass.setSize(w, h); }
  render() { this.composer.render(); }
}
