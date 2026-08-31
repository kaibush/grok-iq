import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { AxiosError } from 'axios'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import {
  ApiError,
  AUTH_REQUIRED_EVENT,
  isAuthenticationRequiredCode,
} from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { DirectionProvider } from './context/direction-provider'
import { FontProvider } from './context/font-provider'
import { TanStackDevtoolsProvider } from './context/tanstack-devtools-provider'
import { ThemeProvider } from './context/theme-provider'
// Generated Routes
import { routeTree } from './routeTree.gen'
// Styles
import './styles/index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // eslint-disable-next-line no-console
        if (import.meta.env.DEV) console.log({ failureCount, error })

        if (failureCount >= 0 && import.meta.env.DEV) return false
        if (failureCount > 3 && import.meta.env.PROD) return false

        return !(
          (error instanceof AxiosError &&
            [401, 403].includes(error.response?.status ?? 0)) ||
          (error instanceof ApiError && [401, 403].includes(error.status))
        )
      },
      refetchOnWindowFocus: import.meta.env.PROD,
      staleTime: 10 * 1000, // 10s
      gcTime: 2 * 60 * 1000,
    },
    mutations: {
      onError: (error) => {
        if (error instanceof ApiError) {
          if (
            error.status === 401 &&
            isAuthenticationRequiredCode(error.code)
          ) {
            return
          }
          toast.error(error.message || '服务请求失败')
          return
        }
        handleServerError(error)

        if (error instanceof AxiosError) {
          if (error.response?.status === 304) {
            toast.error('Content not modified!')
          }
        }
      },
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof AxiosError) {
        if (error.response?.status === 401) {
          toast.error('Session expired!')
          useAuthStore.getState().auth.reset()
          const redirect = `${router.history.location.href}`
          router.navigate({ to: '/sign-in', search: { redirect } })
        }
        if (error.response?.status === 500) {
          toast.error('Internal Server Error!')
          // Only navigate to error page in production to avoid disrupting HMR in development
          if (import.meta.env.PROD) {
            router.navigate({ to: '/500' })
          }
        }
        if (error.response?.status === 403) {
          // router.navigate("/forbidden", { replace: true });
        }
      }
      if (error instanceof ApiError && error.status >= 500) {
        toast.error(error.message || '服务请求失败')
      } else if (
        error instanceof ApiError &&
        error.status === 401 &&
        !isAuthenticationRequiredCode(error.code)
      ) {
        toast.error(error.message || '请求鉴权失败')
      }
    },
  }),
})

// Create a new router instance
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

let authRedirecting = false
window.addEventListener(AUTH_REQUIRED_EVENT, (event) => {
  if (authRedirecting || router.history.location.pathname === '/sign-in') {
    return
  }
  const setupRequired = Boolean(
    (event as CustomEvent<{ setupRequired?: boolean }>).detail?.setupRequired
  )
  authRedirecting = true
  useAuthStore.getState().auth.reset()
  queryClient.clear()
  const redirect = router.history.location.href
  toast.error(setupRequired ? '请先创建管理员账号' : '登录已失效，请重新登录')
  void router
    .navigate({ to: '/sign-in', search: { redirect }, replace: true })
    .finally(() => {
      window.setTimeout(() => {
        authRedirecting = false
      }, 1000)
    })
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FontProvider>
            <DirectionProvider>
              <TanStackDevtoolsProvider>
                <RouterProvider router={router} />
              </TanStackDevtoolsProvider>
            </DirectionProvider>
          </FontProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
