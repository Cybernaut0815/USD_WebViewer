# Superbuild of the wasm32 SDK the viewer core links against:
# oneTBB, OpenSubdiv, MaterialX and OpenUSD (imaging + usdImaging, no GPU).
#
#   emsdk_env first, then:
#   cmake -S sdk -B <build> -G Ninja -DSDK_PREFIX=<prefix> && cmake --build <build>
cmake_minimum_required(VERSION 3.27)
project(sdk NONE)
include(ExternalProject)

if(NOT DEFINED ENV{EMSDK})
    message(FATAL_ERROR "EMSDK is not set: run emsdk_env first")
endif()
file(TO_CMAKE_PATH "$ENV{EMSDK}" EMSDK)
set(SDK_PREFIX "${CMAKE_BINARY_DIR}/../sdk" CACHE PATH "Install prefix of the SDK")
get_filename_component(P "${SDK_PREFIX}" ABSOLUTE)

set(WASM_FLAGS "-pthread --use-port=zlib")
set(COMMON
    -DCMAKE_TOOLCHAIN_FILE:FILEPATH=${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake
    -DCMAKE_BUILD_TYPE:STRING=Release
    -DCMAKE_INSTALL_PREFIX:PATH=${P}
    -DCMAKE_PREFIX_PATH:PATH=${P}
    -DCMAKE_FIND_ROOT_PATH:PATH=${P}
    -DBUILD_SHARED_LIBS:BOOL=OFF
)
set(PATCH ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_SOURCE_DIR}/patch.cmake)
# Archives already present here with a matching hash are not downloaded again
# (useful where CMake's own TLS setup cannot reach GitHub).
set(DL "${CMAKE_BINARY_DIR}/../dl")

ExternalProject_Add(onetbb
    URL https://github.com/oneapi-src/oneTBB/archive/refs/tags/v2021.12.0.zip
    URL_HASH SHA256=fe6ca052b5bdd2c6e0616b360c9b0dcbcc46e01bbd0aa8fd0517c17fc58931db
    DOWNLOAD_DIR ${DL}
    DOWNLOAD_NAME onetbb-2021.12.0.zip
    CMAKE_GENERATOR Ninja
    CMAKE_CACHE_ARGS ${COMMON}
        -DTBB_TEST:BOOL=OFF
        -DTBB_STRICT:BOOL=OFF
        -DCMAKE_C_FLAGS:STRING=${WASM_FLAGS}
        -DCMAKE_CXX_FLAGS:STRING=${WASM_FLAGS}
)

ExternalProject_Add(opensubdiv
    URL https://github.com/PixarAnimationStudios/OpenSubdiv/archive/v3_6_1.zip
    URL_HASH SHA256=f2a42d8af5b3e1d51b9d6b243c1c3bac9d6044e3715cd19968723b49231039cc
    DOWNLOAD_DIR ${DL}
    DOWNLOAD_NAME opensubdiv-3.6.1.zip
    CMAKE_GENERATOR Ninja
    CMAKE_CACHE_ARGS ${COMMON}
        -DNO_EXAMPLES:BOOL=ON -DNO_TUTORIALS:BOOL=ON -DNO_REGRESSION:BOOL=ON -DNO_DOC:BOOL=ON
        -DNO_OMP:BOOL=ON -DNO_CUDA:BOOL=ON -DNO_OPENCL:BOOL=ON -DNO_DX:BOOL=ON
        -DNO_TESTS:BOOL=ON -DNO_GLEW:BOOL=ON -DNO_GLFW:BOOL=ON -DNO_PTEX:BOOL=ON
        -DNO_TBB:BOOL=ON -DNO_METAL:BOOL=ON -DNO_OPENGL:BOOL=ON
        -DCMAKE_C_FLAGS:STRING=${WASM_FLAGS}
        -DCMAKE_CXX_FLAGS:STRING=${WASM_FLAGS}
)

# One generator has to stay on, otherwise MaterialX does not install its
# standard library and its package config fails.
ExternalProject_Add(materialx
    URL https://github.com/AcademySoftwareFoundation/MaterialX/archive/v1.39.5.zip
    URL_HASH SHA256=830b33e96069a69440df175d8ab0951b292893030d825235fbb3b3f846604dda
    DOWNLOAD_DIR ${DL}
    DOWNLOAD_NAME materialx-1.39.5.zip
    PATCH_COMMAND ${PATCH} materialx
    CMAKE_GENERATOR Ninja
    CMAKE_CACHE_ARGS ${COMMON}
        -DMATERIALX_BUILD_SHARED_LIBS:BOOL=OFF
        -DMATERIALX_BUILD_GEN_GLSL:BOOL=ON
        -DMATERIALX_BUILD_GEN_OSL:BOOL=OFF
        -DMATERIALX_BUILD_GEN_MDL:BOOL=OFF
        -DMATERIALX_BUILD_GEN_MSL:BOOL=OFF
        -DMATERIALX_BUILD_GEN_SLANG:BOOL=OFF
        -DMATERIALX_BUILD_RENDER:BOOL=OFF
        -DMATERIALX_BUILD_TESTS:BOOL=OFF
        -DMATERIALX_BUILD_USE_CCACHE:BOOL=OFF # ccache cannot launch the .bat compiler drivers
        "-DCMAKE_CXX_FLAGS:STRING=-pthread -fexceptions"
)
# usdMtlx embeds every file of the installed standard library into the wasm.
# Only the .mtlx node definitions are needed, not the generator sources.
ExternalProject_Add_Step(materialx prune
    COMMAND ${PATCH} prune ${P}
    DEPENDEES install
)

ExternalProject_Add(openusd
    URL https://github.com/PixarAnimationStudios/OpenUSD/archive/refs/tags/v26.08.zip
    URL_HASH SHA256=fbf509e8292055a0be7801f56218ed5d15a3c9022e24636fcc9ca8587345c760
    DOWNLOAD_DIR ${DL}
    DOWNLOAD_NAME openusd-26.08.zip
    PATCH_COMMAND ${PATCH} openusd
    DEPENDS onetbb opensubdiv materialx
    CMAKE_GENERATOR Ninja
    CMAKE_CACHE_ARGS ${COMMON}
        -DPXR_BUILD_IMAGING:BOOL=ON
        -DPXR_BUILD_USD_IMAGING:BOOL=ON
        -DPXR_ENABLE_GL_SUPPORT:BOOL=OFF
        -DPXR_ENABLE_METAL_SUPPORT:BOOL=OFF
        -DPXR_ENABLE_VULKAN_SUPPORT:BOOL=OFF
        -DPXR_ENABLE_MATERIALX_SUPPORT:BOOL=ON
        -DMaterialX_DIR:PATH=${P}/lib/cmake/MaterialX
        -DPXR_ENABLE_PYTHON_SUPPORT:BOOL=OFF
        -DPXR_BUILD_TESTS:BOOL=OFF
        -DPXR_BUILD_EXAMPLES:BOOL=OFF
        -DPXR_BUILD_TUTORIALS:BOOL=OFF
        -DPXR_BUILD_USD_TOOLS:BOOL=OFF
        -DPXR_BUILD_USD_VALIDATION:BOOL=OFF
        -DPXR_BUILD_DOCUMENTATION:BOOL=OFF
        -DPXR_BUILD_USDVIEW:BOOL=OFF
        -DPXR_ENABLE_PTEX_SUPPORT:BOOL=OFF
        -DPXR_ENABLE_OPENVDB_SUPPORT:BOOL=OFF
        -DPXR_BUILD_EMBREE_PLUGIN:BOOL=OFF
        -DPXR_BUILD_PRMAN_PLUGIN:BOOL=OFF
        -DPXR_BUILD_OPENIMAGEIO_PLUGIN:BOOL=OFF
        -DPXR_BUILD_OPENCOLORIO_PLUGIN:BOOL=OFF
        -DPXR_BUILD_ALEMBIC_PLUGIN:BOOL=OFF
        -DPXR_BUILD_DRACO_PLUGIN:BOOL=OFF
        # Same lookups Pixar's build_usd.py passes for wasm targets.
        -DPXR_FIND_TBB_IN_CONFIG:BOOL=ON
        -DTBB_INCLUDE_DIRS:PATH=${P}/include
        -DTBB_tbb_LIBRARY_RELEASE:FILEPATH=${P}/lib/libtbb.a
        -DOPENSUBDIV_INCLUDE_DIR:PATH=${P}/include
        -DOPENSUBDIV_OSDCPU_LIBRARY:FILEPATH=${P}/lib/libosdCPU.a
        -DCMAKE_C_FLAGS:STRING=${WASM_FLAGS}
        -DCMAKE_CXX_FLAGS:STRING=${WASM_FLAGS}
        -DCMAKE_EXE_LINKER_FLAGS:STRING=-pthread
)
