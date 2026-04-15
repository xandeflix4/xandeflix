import { Media, MediaType, Category } from '../types';

export const MOCK_MEDIA: Media[] = [
  {
    id: '1',
    title: 'Sintra: O Mistério',
    description: 'Um thriller psicológico ambientado nas névoas de Sintra, onde segredos antigos começam a emergir.',
    thumbnail: 'https://picsum.photos/seed/sintra/400/225',
    backdrop: 'https://picsum.photos/seed/sintra-bg/1920/1080',
    videoUrl: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    type: MediaType.MOVIE,
    year: 2024,
    rating: '16+',
    duration: '1h 45min',
    category: 'Suspense'
  },
  {
    id: '2',
    title: 'O Código de Lisboa',
    description: 'Um hacker talentoso descobre um segredo de estado escondido nos servidores da capital portuguesa.',
    thumbnail: 'https://picsum.photos/seed/lisbon/400/225',
    backdrop: 'https://picsum.photos/seed/lisbon-bg/1920/1080',
    videoUrl: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-911d-472c-9116-5f4f3351762d.m3u8',
    type: MediaType.MOVIE,
    year: 2023,
    rating: '14+',
    duration: '2h 10min',
    category: 'Ação'
  },
  {
    id: '3',
    title: 'Mar de Palha',
    description: 'A vida de um pescador muda drasticamente após um encontro inesperado no Rio Tejo.',
    thumbnail: 'https://picsum.photos/seed/tejo/400/225',
    backdrop: 'https://picsum.photos/seed/tejo-bg/1920/1080',
    videoUrl: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    type: MediaType.MOVIE,
    year: 2022,
    rating: 'L',
    duration: '1h 30min',
    category: 'Drama'
  },
  {
    id: '4',
    title: 'Noite no Porto',
    description: 'Uma comédia romântica que percorre as ruas iluminadas do Porto durante o São João.',
    thumbnail: 'https://picsum.photos/seed/porto/400/225',
    backdrop: 'https://picsum.photos/seed/porto-bg/1920/1080',
    videoUrl: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    type: MediaType.MOVIE,
    year: 2024,
    rating: '12+',
    duration: '1h 55min',
    category: 'Comédia'
  },
  {
    id: '5',
    title: 'Alentejo Infinito',
    description: 'Um documentário visual sobre as vastas planícies e o silêncio do Alentejo.',
    thumbnail: 'https://picsum.photos/seed/alentejo/400/225',
    backdrop: 'https://picsum.photos/seed/alentejo-bg/1920/1080',
    videoUrl: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    type: MediaType.MOVIE,
    year: 2021,
    rating: 'L',
    duration: '1h 20min',
    category: 'Documentário'
  },
  {
    id: '6',
    title: 'O Último Fado',
    description: 'A jornada de uma jovem fadista em busca de sua própria voz nas casas de fado de Alfama.',
    thumbnail: 'https://picsum.photos/seed/fado/400/225',
    backdrop: 'https://picsum.photos/seed/fado-bg/1920/1080',
    videoUrl: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    type: MediaType.MOVIE,
    year: 2023,
    rating: '10+',
    duration: '1h 50min',
    category: 'Drama'
  }
];

export const MOCK_CATEGORIES: Category[] = [
  {
    id: 'cat-1',
    title: 'Canais de Notícias',
    type: 'live',
    items: [MOCK_MEDIA[0], MOCK_MEDIA[1], MOCK_MEDIA[2], MOCK_MEDIA[3], MOCK_MEDIA[4], MOCK_MEDIA[5]]
  },
  {
    id: 'cat-2',
    title: 'Filmes de Ação',
    type: 'movie',
    items: [MOCK_MEDIA[5], MOCK_MEDIA[4], MOCK_MEDIA[3], MOCK_MEDIA[2], MOCK_MEDIA[1], MOCK_MEDIA[0]]
  },
  {
    id: 'cat-3',
    title: 'Séries Originais',
    type: 'series',
    items: [MOCK_MEDIA[1], MOCK_MEDIA[3], MOCK_MEDIA[5]]
  }
];
