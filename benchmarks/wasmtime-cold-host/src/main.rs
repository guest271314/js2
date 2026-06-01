// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Minimal Wasmtime embedding host for the #1764 hot-runtime benchmark cold
// lane. The process owns a warm Engine plus compiled Module, then each sample
// allocates a fresh Store + Instance and calls the exported run(arg) once.

use std::env;
use std::error::Error;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use wasmtime::{Config, Engine, Instance, Module, Store};

#[derive(Clone, Copy)]
enum RunSignature {
    I32ToI32,
    I32ToF64,
    F64ToI32,
    F64ToF64,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("wasmtime-cold-host: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let wasm_path = args
        .next()
        .ok_or("usage: wasmtime-cold-host <module.wasm> <arg> <runs>")?;
    let arg_text = args
        .next()
        .ok_or("usage: wasmtime-cold-host <module.wasm> <arg> <runs>")?;
    let runs_text = args
        .next()
        .ok_or("usage: wasmtime-cold-host <module.wasm> <arg> <runs>")?;
    if args.next().is_some() {
        return Err("usage: wasmtime-cold-host <module.wasm> <arg> <runs>".into());
    }

    let arg_i32: i32 = arg_text.parse()?;
    let arg_f64: f64 = arg_text.parse()?;
    let runs: usize = runs_text.parse()?;
    if runs == 0 {
        return Err("runs must be greater than zero".into());
    }

    let mut config = Config::new();
    config.wasm_function_references(true);
    config.wasm_gc(true);

    let engine = Engine::new(&config)?;
    let module = Module::from_file(&engine, Path::new(&wasm_path))?;
    let signature = detect_run_signature(&engine, &module)?;

    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        let mut store = Store::new(&engine, ());
        let instance = Instance::new(&mut store, &module, &[])?;
        call_run_once(signature, &mut store, &instance, arg_i32, arg_f64)?;
        samples.push(t0.elapsed().as_secs_f64() * 1000.0);
    }

    let samples = samples
        .iter()
        .map(|sample| sample.to_string())
        .collect::<Vec<_>>()
        .join(",");
    println!("{{\"samplesMs\":[{samples}]}}");
    Ok(())
}

fn detect_run_signature(engine: &Engine, module: &Module) -> Result<RunSignature, Box<dyn Error>> {
    let mut store = Store::new(engine, ());
    let instance = Instance::new(&mut store, module, &[])?;

    if instance
        .get_typed_func::<i32, i32>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::I32ToI32);
    }
    if instance
        .get_typed_func::<i32, f64>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::I32ToF64);
    }
    if instance
        .get_typed_func::<f64, i32>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::F64ToI32);
    }
    if instance
        .get_typed_func::<f64, f64>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::F64ToF64);
    }

    Err("exported run function must be i32/f64 -> i32/f64".into())
}

fn call_run_once(
    signature: RunSignature,
    store: &mut Store<()>,
    instance: &Instance,
    arg_i32: i32,
    arg_f64: f64,
) -> Result<(), Box<dyn Error>> {
    match signature {
        RunSignature::I32ToI32 => {
            let run = instance.get_typed_func::<i32, i32>(&mut *store, "run")?;
            black_box(run.call(&mut *store, arg_i32)?);
        }
        RunSignature::I32ToF64 => {
            let run = instance.get_typed_func::<i32, f64>(&mut *store, "run")?;
            black_box(run.call(&mut *store, arg_i32)?);
        }
        RunSignature::F64ToI32 => {
            let run = instance.get_typed_func::<f64, i32>(&mut *store, "run")?;
            black_box(run.call(&mut *store, arg_f64)?);
        }
        RunSignature::F64ToF64 => {
            let run = instance.get_typed_func::<f64, f64>(&mut *store, "run")?;
            black_box(run.call(&mut *store, arg_f64)?);
        }
    }
    Ok(())
}
